require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const qr = require('qr-image');
const cors = require('cors');
const fs = require('fs');
const mysql = require('mysql2');
const path = require('path');

const app = express();
const port = process.env.PORT || 781;

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

const insertIfNotExists = (table, conditions, values) => {
    const conditionString = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
    const query = `SELECT COUNT(*) as count FROM ${table} WHERE ${conditionString}`;
    const conditionValues = Object.values(conditions);

    db.query(query, conditionValues, (err, results) => {
        if (err) {
            console.error(`Error checking for existing entry in ${table}:`, err.stack);
            return;
        }

        if (results[0].count === 0) {
            const insertQuery = `INSERT INTO ${table} (${Object.keys(values).join(', ')}) VALUES (${Object.keys(values).map(() => '?').join(', ')})`;
            db.query(insertQuery, Object.values(values), (err, results) => {
                if (err) {
                    console.error(`Error inserting data into ${table}:`, err.stack);
                } else {
                    console.log(`Data inserted successfully into ${table}`);
                }
            });
        } else {
            console.log(`Entry already exists in ${table}, skipping insert.`);
        }
    });
};

app.get('/initialize-client', async (req, res) => {
    const { clientId } = req.query;

    if (!clientId) {
        return res.status(400).json({ error: 'clientId is required in the query parameters' });
    }

    try {
        const client = new Client({
            qrMaxRetries: 1,
            authStrategy: new LocalAuth({
                clientId: clientId,
                dataPath: path.join(__dirname, 'sessions', clientId) // Store the session inside 'sessions/clientId' folder
            }),
            restartOnAuthFail: true,
            puppeteer: {
                headless: true,
                timeout: 120000,
                args: ["--no-sandbox",'--proxy-server=46.166.137.38:31499']
            }
        });

        client.initialize();

        client.on('qr', (qrCode) => {
            console.log(`QR RECEIVED for ${clientId}`);
            const qrImage = qr.image(qrCode, { type: 'png' });
            qrImage.pipe(res, { end: true });
        });

        client.on('ready', () => {
            console.log(`Client is ready for ${clientId}`);

            client.on('message', (message) => {
                const logMessage = {
                    clientId: message.from,
                    number: message.to,
                    message: message.body
                };

                insertIfNotExists('message_logs', { clientId: logMessage.clientId, number: logMessage.number, message: logMessage.message }, logMessage);
            });

            client.getContacts().then(contacts => {
                const extractedData = contacts.map(contact => ({
                    name: contact.name,
                    contactNumber: contact.isGroup ? null : contact.id.user,
                    type: contact.isGroup ? 'Group' : 'Private'
                }));

                console.log('Extracted contacts data:', extractedData);

                extractedData.forEach(contact => {
                    insertIfNotExists('contacts', {
                        clientId,
                        name: contact.name,
                        contactNumber: contact.contactNumber,
                        type: contact.type
                    }, {
                        clientId,
                        name: contact.name,
                        contactNumber: contact.contactNumber,
                        type: contact.type
                    });
                });
            }).catch(error => {
                console.error('Error fetching contacts:', error);
            });

            client.getChats().then(chats => {
                const extractedData = chats.map(chat => ({
                    name: chat.name,
                    contactNumber: chat.isGroup ? null : chat.id.user,
                    type: chat.isGroup ? 'Group' : 'Private'
                }));

                console.log('Extracted chats data:', extractedData);

                extractedData.forEach(chatData => {
                    insertIfNotExists('chats', {
                        clientId,
                        name: chatData.name,
                        contactNumber: chatData.contactNumber,
                        type: chatData.type
                    }, {
                        clientId,
                        name: chatData.name,
                        contactNumber: chatData.contactNumber,
                        type: chatData.type
                    });
                });
            }).catch(error => {
                console.error('Error fetching chats:', error);
            });

            activeClients[clientId] = client;
            const phoneNumber = client.info.wid.user;

            insertIfNotExists('clients', { clientId }, { clientId, phonenumber: phoneNumber, status: 'ready' });
        });

        client.on('authenticated', () => {
            console.log(`${clientId} authenticated`);
        });

        client.on('auth_failure', (message) => {
            console.error('Authentication failed:', message);
        });

        client.on('disconnected', (reason) => {
            delete activeClients[clientId];
            db.query('UPDATE clients SET status = "logged_out" WHERE clientId = ?', [clientId], (err, results) => {
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
    const { clientId } = req.query;

    if (!clientId) {
        return res.status(400).json({ error: 'clientId is required in the query parameters' });
    }

    const client = activeClients[clientId];
    if (client) {
        res.status(200).json({ message: `Client ${clientId} is ready` });
    } else {
        res.status(404).json({ error: `Client ${clientId} not found or not ready` });
    }
});

app.get('/message', (req, res) => {
    const { clientId, to: number, message: text } = req.query;

    if (!clientId || !number || !text) {
        return res.status(400).json({ error: 'clientId, number, and message are required in the query parameters' });
    }

    const client = activeClients[clientId];
    if (client) {
        const chatId = number.substring(1) + "@c.us";
        client.sendMessage(chatId, text).then(() => {
            insertIfNotExists('message_logs', { clientId, number, message: text }, { clientId, number, message: text });
            res.status(200).json({ message: `Client ${clientId} sent message successfully` });
        }).catch(error => {
            console.error('Error sending message:', error);
            res.status(500).json({ error: 'Failed to send message' });
        });
    } else {
        res.status(404).json({ error: `Client ${clientId} not found or not ready` });
    }
});

app.get('/set-status', async (req, res) => {
    const { clientId, statusMessage } = req.query;

    if (!clientId || !statusMessage) {
        return res.status(400).json({ error: 'clientId and statusMessage are required in the query parameters' });
    }

    const client = activeClients[clientId];
    if (client) {
        try {
            await client.setStatus(statusMessage);
            res.status(200).json({ message: `Status set to "${statusMessage}" for client ${clientId}` });
        } catch (error) {
            console.error('Error setting status:', error);
            res.status(500).json({ error: 'Failed to set status' });
        }
    } else {
        res.status(404).json({ error: `Client ${clientId} not found or not ready` });
    }
});

app.get('/logout', async (req, res) => {
    const { clientId } = req.query;

    if (!clientId) {
        return res.status(400).json({ error: 'clientId is required in the query parameters' });
    }

    const client = activeClients[clientId];
    if (client) {
        try {
            await client.logout();
            console.log(`Client ${clientId} logged out successfully`);
            delete activeClients[clientId];

            db.query('UPDATE clients SET status = "logged_out" WHERE clientId = ?', [clientId], (err, results) => {
                if (err) {
                    console.error('Error updating client status in MySQL:', err.stack);
                } else {
                    console.log('Client status updated successfully in MySQL');
                }
            });

            res.status(200).json({ message: `Client ${clientId} logged out` });
        } catch (error) {
            console.error('Error logging out client:', error);
            res.status(500).json({ error: 'Failed to log out client' });
        }
    } else {
        res.status(404).json({ error: `Client ${clientId} not found or not ready` });
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://207.244.239.151:${port}`);
});
