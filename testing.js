require('dotenv').config(); // Add this at the top of your file

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const qr = require('qr-image');
const cors = require('cors');
const fs = require('fs');
const mysql = require('mysql2');
const app = express();
const port = process.env.PORT || 3000;

// MySQL connection setup
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL:', err.stack);
        return;
    }
    console.log('Connected to MySQL as id ' + db.threadId);
});

app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST']
}));
app.use(bodyParser.json());

const activeClients = {};

app.get('/initialize-client', async (req, res) => {
    const { clientId } = req.query;

    try {
        const client = new Client({
            qrMaxRetries: 1,
            authStrategy: new LocalAuth({ clientId: clientId }),
            restartOnAuthFail: true,
            webVersion: "2.2412.54",
            webVersionCache: {
                type: "remote",
                remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
            },
            puppeteer: {
                headless: true,
                // args: ["--no-sandbox",'--proxy-server=46.166.137.38:31499']
            }
        });

        client.initialize();

        client.on('qr', (qrCode) => {
            console.log(`QR RECEIVED for ${clientId}`, qrCode);
            const qrImage = qr.image(qrCode, { type: 'png' });
            qrImage.pipe(res, { end: true });
        });

        client.on('ready', () => {
            console.log(`Client is ready for ${clientId}`);

            client.on('message', (message) => {
                const clientId = message.from;
                const number = message.to;
                const text = message.body;

                // Log the message details to the MySQL database
                db.query(
                    'INSERT INTO message_logs (clientId, number, message) VALUES (?, ?, ?)',
                    [clientId, number, text],
                    (err, results) => {
                        if (err) {
                            console.error('Error inserting message into MySQL:', err);
                        } else {
                            console.log('Message logged successfully');
                        }
                    }
                );
            });

            client.getContacts().then(contacts => {
                const extractedData = contacts.map(contact => {
                    if (contact.isGroup) {
                        return {
                            name: contact.name,
                            contactNumber: null,
                            type: 'Group'
                        };
                    } else {
                        return {
                            name: contact.name,
                            contactNumber: contact.id.user,
                            type: 'Private'
                        };
                    }
                });

                extractedData.forEach(contact => {
                    const query = `INSERT INTO contacts (clientId, name, contactNumber, type) VALUES (?, ?, ?, ?)`;
                    db.query(query, [clientId, contact.name, contact.contactNumber, contact.type], (err, results) => {
                        if (err) {
                            console.error('Error inserting contact data into MySQL:', err.stack);
                        } else {
                            console.log('Contact data inserted successfully into MySQL');
                        }
                    });
                });
            });

            client.getChats().then(chats => {
                const extractedData = chats.map(chat => {
                    if (chat.isGroup) {
                        return {
                            name: chat.name,
                            contactNumber: null,
                            type: 'Group'
                        };
                    } else {
                        return {
                            name: chat.name,
                            contactNumber: chat.id.user,
                            type: 'Private'
                        };
                    }
                });

                extractedData.forEach(chatData => {
                    const query = `INSERT INTO chats (clientId, name, contactNumber, type) VALUES (?, ?, ?, ?)`;
                    db.query(query, [clientId, chatData.name, chatData.contactNumber, chatData.type], (err, results) => {
                        if (err) {
                            console.error('Error inserting chat data into MySQL:', err.stack);
                        } else {
                            console.log('Chat data inserted successfully into MySQL');
                        }
                    });
                });
            }).catch(error => {
                console.error('Error fetching chats:', error);
            });

            activeClients[clientId] = client;

            const query = `INSERT INTO clients (clientId, status) VALUES (?, 'ready') 
                           ON DUPLICATE KEY UPDATE status='ready'`;
            db.query(query, [clientId], (err, results) => {
                if (err) {
                    console.error('Error updating client status in MySQL:', err.stack);
                } else {
                    console.log('Client status updated successfully in MySQL');
                }
            });
        });

        client.on('authenticated', () => {
            console.log(clientId + ' authenticated');
        });

        client.on('auth_failure', () => {
            console.log('auth_failure');
        });

        client.on('disconnected', () => {
            delete activeClients[clientId];
            const query = `UPDATE clients SET status = 'logout' WHERE clientId = ?`;
            db.query(query, [clientId], (err, results) => {
                if (err) {
                    console.error('Error updating client status in MySQL:', err.stack);
                } else {
                    console.log('Client status updated to disconnected in MySQL');
                }
            });
        });
    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get('/status', (req, res) => {
    const requestedClientId = req.query.clientId;

    if (!requestedClientId) {
        res.status(400).json({ error: 'clientId is required in the query parameters' });
        return;
    }

    const client = activeClients[requestedClientId];
    if (client) {
        res.status(200).json({ message: `Client ${requestedClientId} is ready` });
    } else {
        res.status(404).json({ error: `Client ${requestedClientId} not found or not ready` });
    }
});

app.get('/message', (req, res) => {
    const requestedClientId = req.query.clientId;
    const number = req.query.to;
    const text = req.query.message;

    if (!requestedClientId || !number || !text) {
        res.status(400).json({ error: 'clientId, number, and text are required in the query parameters' });
        return;
    }

    const client = activeClients[requestedClientId];
    if (client) {
        const chatId = number.substring(1) + "@c.us";
        
        client.sendMessage(chatId, text).then(() => {
            const query = 'INSERT INTO message_logs (clientId, number, message) VALUES (?, ?, ?)';
            const values = [requestedClientId, number, text];
            
            db.query(query, values, (err, results) => {
                if (err) {
                    console.error('Error logging message to MySQL:', err);
                    res.status(500).json({ error: 'Failed to log message' });
                } else {
                    console.log('Message logged successfully');
                    res.status(200).json({ message: `Client ${requestedClientId} sent message successfully` });
                }
            });
        }).catch(error => {
            console.error('Error sending message:', error);
            res.status(500).json({ error: 'Failed to send message' });
        });
    } else {
        res.status(404).json({ error: `Client ${requestedClientId} not found or not ready` });
    }
});

app.get('/set-status', async (req, res) => {
    const { clientId, statusMessage } = req.query;

    if (!clientId || !statusMessage) {
        res.status(400).json({ error: 'clientId and statusMessage are required in the query parameters' });
        return;
    }

    const client = activeClients[clientId];
    if (client) {
        await client.setStatus(statusMessage);
        res.status(200).json({ message: `Status set to "${statusMessage}" for client ${clientId}` });
    } else {
        res.status(404).json({ error: `Client ${clientId} not found or not ready` });
    }
});



app.get('/logout', async (req, res) => {
    const { clientId } = req.query;

    if (!clientId) {
        return res.status(400).json({ error: 'clientId is required in the query parameters' });
    }

    const filePath = `.wwebjs_auth/session-${clientId}/Default/chrome_debug.log`;

    const client = activeClients[clientId];

    if (client) {
        try {
            await client.logout();
            console.log(`Client ${clientId} logged out successfully`);

            delete activeClients[clientId];

            const logoutQuery = `UPDATE clients SET status = 'logged_out' WHERE clientId = ?`;
            db.query(logoutQuery, [clientId], (err, results) => {
                if (err) {
                    console.error('Error updating client status in MySQL:', err.stack);
                } else {
                    console.log('Client status updated successfully in MySQL');
                }
            });

            // Wait for a short period before attempting to delete the file
            setTimeout(() => {
                deleteFileWithRetries(filePath);
            }, 3000); // Wait for 3 seconds

            res.status(200).json({ message: `Client ${clientId} was logged out and file deletion is in progress` });
        } catch (error) {
            console.error('Error during logout:', error);
            res.status(500).json({ error: 'Failed to log out client' });
        }
    } else {
        res.status(404).json({ error: `Client ${clientId} not found` });
    }
});

const deleteFileWithRetries = (filePath, attempts = 5) => {
    fs.unlink(filePath, (err) => {
        if (err) {
            if (err.code === 'EBUSY' && attempts > 0) {
                console.error(`File is busy. Retrying deletion... Attempts left: ${attempts}`);
                setTimeout(() => deleteFileWithRetries(filePath, attempts - 1), 1000 * (6 - attempts)); // Exponential backoff
            } else {
                console.error('Failed to delete file:', err);
            }
        } else {
            console.log('File deleted successfully');
        }
    });
};

// Start the Express server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
