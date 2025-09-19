// netlify/functions/identify.js
const crypto = require('crypto');
const FormData = require('form-data');
const fetch = require('node-fetch');

// ACRCloud configuration - these will be set as environment variables in Netlify
const acrcloudConfig = {
    host: 'identify-ap-southeast-1.acrcloud.com',
    access_key: process.env.ACRCLOUD_ACCESS_KEY,
    access_secret: process.env.ACRCLOUD_ACCESS_SECRET,
    endpoint: '/v1/identify'
};

// Generate HMAC-SHA1 signature
function generateSignature(stringToSign, secret) {
    return crypto.createHmac('sha1', secret)
                 .update(stringToSign, 'utf8')
                 .digest('base64');
}

function parseACRCloudResponse(data) {
    if (data && data.status && data.status.code === 0 && data.metadata && data.metadata.music && data.metadata.music.length > 0) {
        const music = data.metadata.music[0];
        
        return {
            success: true,
            song: {
                title: music.title || 'Unknown Title',
                artist: music.artists && music.artists.length > 0 ? music.artists[0].name : 'Unknown Artist',
                album: music.album ? music.album.name : 'Unknown Album',
                year: music.release_date ? music.release_date.substring(0, 4) : 'Unknown',
                confidence: Math.round(music.score * 100) || 95,
                duration: music.duration_ms ? Math.floor(music.duration_ms / 1000) : null,
                spotify_url: music.external_metadata?.spotify?.track?.external_urls?.spotify,
                youtube_url: music.external_metadata?.youtube?.vid ? `https://www.youtube.com/watch?v=${music.external_metadata.youtube.vid}` : null,
                apple_url: music.external_metadata?.apple_music?.url,
                cover_art: music.album?.artwork_url_500 || music.album?.artwork_url,
                preview_url: music.external_metadata?.spotify?.track?.preview_url,
                isReal: true
            }
        };
    } else if (data && data.status && data.status.code === 1001) {
        return {
            success: false,
            error: 'No music found in database',
            code: 1001
        };
    } else if (data && data.status && data.status.code === 3001) {
        return {
            success: false,
            error: 'Invalid access key',
            code: 3001
        };
    } else if (data && data.status && data.status.code === 3003) {
        return {
            success: false,
            error: 'Rate limit exceeded',
            code: 3003
        };
    } else {
        return {
            success: false,
            error: 'Unknown response format',
            data: data
        };
    }
}

exports.handler = async (event, context) => {
    // Handle CORS
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };

    // Handle preflight requests
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers,
            body: ''
        };
    }

    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        // Check if API keys are configured
        if (!acrcloudConfig.access_key || !acrcloudConfig.access_secret) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ error: 'ACRCloud API keys not configured' })
            };
        }

        // Parse the multipart form data
        const contentType = event.headers['content-type'] || event.headers['Content-Type'];
        if (!contentType || !contentType.includes('multipart/form-data')) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Content-Type must be multipart/form-data' })
            };
        }

        // For Netlify Functions, we need to handle binary data differently
        const body = event.isBase64Encoded ? Buffer.from(event.body, 'base64') : Buffer.from(event.body);
        
        // Extract boundary from content-type
        const boundary = contentType.split('boundary=')[1];
        if (!boundary) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Missing boundary in multipart data' })
            };
        }

        // Parse multipart data manually (simplified for audio file)
        const parts = body.toString('binary').split('--' + boundary);
        let audioBuffer = null;
        let filename = 'audio.wav';

        for (let part of parts) {
            if (part.includes('Content-Disposition: form-data') && part.includes('name="audio"')) {
                const headerEnd = part.indexOf('\r\n\r\n');
                if (headerEnd !== -1) {
                    const fileData = part.substring(headerEnd + 4);
                    // Remove trailing boundary data
                    const cleanData = fileData.substring(0, fileData.lastIndexOf('\r\n'));
                    audioBuffer = Buffer.from(cleanData, 'binary');
                    
                    // Extract filename if present
                    const filenameMatch = part.match(/filename="([^"]+)"/);
                    if (filenameMatch) {
                        filename = filenameMatch[1];
                    }
                    break;
                }
            }
        }

        if (!audioBuffer) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'No audio file found in request' })
            };
        }

        console.log('Audio file received:', {
            filename: filename,
            size: audioBuffer.length
        });

        // Prepare ACRCloud request
        const timestamp = Math.floor(Date.now() / 1000);
        const stringToSign = `POST\n${acrcloudConfig.endpoint}\n${acrcloudConfig.access_key}\naudio\n1\n${timestamp}`;
        const signature = generateSignature(stringToSign, acrcloudConfig.access_secret);

        // Create form data for ACRCloud
        const formData = new FormData();
        formData.append('sample', audioBuffer, {
            filename: filename,
            contentType: 'audio/wav'
        });
        formData.append('sample_bytes', audioBuffer.length.toString());
        formData.append('access_key', acrcloudConfig.access_key);
        formData.append('data_type', 'audio');
        formData.append('signature_version', '1');
        formData.append('signature', signature);
        formData.append('timestamp', timestamp.toString());

        console.log('Making request to ACRCloud...');

        // Make request to ACRCloud
        const apiUrl = `https://${acrcloudConfig.host}${acrcloudConfig.endpoint}`;
        const response = await fetch(apiUrl, {
            method: 'POST',
            body: formData,
            headers: formData.getHeaders()
        });

        const data = await response.json();
        console.log('ACRCloud response:', data);

        if (!response.ok) {
            console.error('ACRCloud API error:', data);
            return {
                statusCode: response.status,
                headers,
                body: JSON.stringify({ 
                    error: 'ACRCloud API error',
                    details: data 
                })
            };
        }

        // Parse and return result
        const result = parseACRCloudResponse(data);
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(result)
        };

    } catch (error) {
        console.error('Function error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: 'Internal server error',
                message: error.message 
            })
        };
    }
};
