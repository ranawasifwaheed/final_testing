require('dotenv').config();

const { Client, LocalAuth, MessageMedia, Location } = require('whatsapp-web.js');
const express = require('express');
const bodyParser = require('body-parser');
const qr = require('qr-image');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');
const multer = require('multer');
const mime = require('mime-types');
const upload = multer({ dest: 'uploads/' });

const app = express();
const port = process.env.PORT || 781;

const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

db.connect(err => {
    if (err) {
        console.error('Error connecting to MySQL:', err.stack);
        return;
    }
    console.log('Connected to MySQL as id ' + db.threadId);
});

app.use(cors({ origin: '*', methods: ['GET', 'POST'] }));
app.use(bodyParser.json());

const activeClients = {};
const readyClients = {};

const insertIfNotExists = (table, conditions, values) => {
    const conditionString = Object.keys(conditions).map(key => `${key} = ?`).join(' AND ');
    const query = `SELECT COUNT(*) as count FROM ${table} WHERE ${conditionString}`;
    const conditionValues = Object.values(conditions);

    db.query(query, conditionValues, (err, results) => {
        if (err) return console.error(`Error checking entry in ${table}:`, err.stack);

        if (results[0].count === 0) {
            const insertQuery = `INSERT INTO ${table} (${Object.keys(values).join(', ')}) VALUES (${Object.keys(values).map(() => '?').join(', ')})`;
            db.query(insertQuery, Object.values(values), (err) => {
                if (err) console.error(`Insert error into ${table}:`, err.stack);
                else console.log(`Data inserted into ${table}`);
            });
        } else {
            console.log(`Entry exists in ${table}, skipping.`);
        }
    });
};

app.get('/initialize-client', async (req, res) => {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    try {
        const client = new Client({
            qrMaxRetries: 1,
            authStrategy: new LocalAuth({
                clientId: clientId,
                dataPath: path.join(__dirname, 'sessions', clientId)
            }),
            restartOnAuthFail: true,
            puppeteer: {
                headless: true,
                timeout: 120000,
                args: ["--no-sandbox"]
            }
        });

        client.initialize();

        client.on('qr', (qrCode) => {
            console.log(`QR RECEIVED for ${clientId}`);
            const qrImage = qr.image(qrCode, { type: 'png' });
            qrImage.pipe(res, { end: true });
        });

        client.on('ready', () => {
            console.log(`Client ready: ${clientId}`);
            readyClients[clientId] = true;
            activeClients[clientId] = client;

            client.on('message', (message) => {
                const logMessage = {
                    clientId: message.from,
                    number: message.to,
                    message: message.body
                };

                insertIfNotExists('message_logs', {
                    clientId: logMessage.clientId,
                    number: logMessage.number,
                    message: logMessage.message
                }, logMessage);
            });

            client.getContacts().then(contacts => {
                contacts.forEach(contact => {
                    const data = {
                        clientId,
                        name: contact.name,
                        contactNumber: contact.isGroup ? null : contact.id.user,
                        type: contact.isGroup ? 'Group' : 'Private'
                    };
                    insertIfNotExists('contacts', data, data);
                });
            });

            client.getChats().then(chats => {
                chats.forEach(chat => {
                    const data = {
                        clientId,
                        name: chat.name,
                        contactNumber: chat.isGroup ? null : chat.id.user,
                        type: chat.isGroup ? 'Group' : 'Private'
                    };
                    insertIfNotExists('chats', data, data);
                });
            });

            const phoneNumber = client.info?.wid?.user || null;
            if (phoneNumber) {
                insertIfNotExists('clients', { clientId }, {
                    clientId,
                    phonenumber: phoneNumber,
                    status: 'ready'
                });
            }
        });

        client.on('authenticated', () => console.log(`${clientId} authenticated`));
        client.on('auth_failure', msg => console.error('Auth failed:', msg));
        client.on('disconnected', reason => {
            console.warn(`Client ${clientId} disconnected: ${reason}`);
            delete activeClients[clientId];
            delete readyClients[clientId];
            db.query('UPDATE clients SET status = "logged_out" WHERE clientId = ?', [clientId]);
        });

    } catch (error) {
        console.error("Error initializing client:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get('/status', (req, res) => {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    if (activeClients[clientId] && readyClients[clientId]) {
        return res.status(200).json({ message: `Client ${clientId} is ready` });
    }
    return res.status(404).json({ error: `Client ${clientId} not found or not ready` });
});

app.get('/message', async (req, res) => {
    const { clientId, to, message: text } = req.query;

    if (!clientId || !to || !text) {
        return res.status(400).json({ error: 'clientId, number, and message are required' });
    }

    const client = activeClients[clientId];
    if (!client || !readyClients[clientId]) {
        return res.status(404).json({ error: `Client ${clientId} not ready` });
    }

    try {
        const sanitized = to.replace(/\D/g, '');
        const numberId = await client.getNumberId(sanitized);
        if (!numberId) {
            return res.status(404).json({ error: `The number ${sanitized} is not registered on WhatsApp` });
        }

        // ✅ Attempt to send message
        await client.sendMessage(numberId._serialized, text);
        console.log(`✅ Message sent to ${numberId._serialized}`);

        // ✅ Try logging separately (non-blocking)
        try {
            insertIfNotExists('message_logs', {
                clientId,
                number: to,
                message: text
            }, {
                clientId,
                number: to,
                message: text
            });
        } catch (logErr) {
            console.warn('⚠️ Warning: Failed to log message. Not blocking response.');
            console.warn(logErr);
        }

        // ✅ Respond with success
        res.status(200).json({ message: `Message sent successfully to ${to}` });

    } catch (error) {
        console.error('❌ ERROR sending message:', error.message);
        console.error(error.stack);
        res.status(500).json({ error: 'Internal server error while sending message' });
    }
});


app.post('/send-media-upload', upload.single('file'), async (req, res) => {
    const { clientId, to, caption } = req.body;
    const file = req.file;

    if (!clientId || !to || !file) {
        return res.status(400).json({ error: 'clientId, to, and file are required' });
    }

    const client = activeClients[clientId];
    if (!client || !readyClients[clientId]) {
        return res.status(404).json({ error: `Client ${clientId} not ready` });
    }

    try {
        const sanitized = to.replace(/\D/g, '');
        const numberId = await client.getNumberId(sanitized);
        if (!numberId) {
            return res.status(404).json({ error: `The number ${sanitized} is not registered on WhatsApp` });
        }

        const mimetype = mime.lookup(file.originalname) || file.mimetype;
        const base64 = fs.readFileSync(file.path, { encoding: 'base64' });
        const media = new MessageMedia(mimetype, base64, file.originalname);

        // ✅ Send media (with optional caption)
        await client.sendMessage(numberId._serialized, media, {
            caption: caption || undefined
        });

        console.log(`✅ Media sent to ${numberId._serialized}`);

        // ✅ Cleanup file
        fs.unlinkSync(file.path);

        // ✅ Log separately
        try {
            insertIfNotExists('message_logs', {
                clientId,
                number: to,
                message: `[MEDIA_UPLOAD] ${file.originalname}`
            }, {
                clientId,
                number: to,
                message: `[MEDIA_UPLOAD] ${file.originalname}`
            });
        } catch (logErr) {
            console.warn('⚠️ Warning: Failed to log media message');
            console.warn(logErr);
        }

        res.status(200).json({ message: `Media sent to ${to}` });

    } catch (err) {
        console.error('❌ ERROR sending media:', err.message);
        console.error(err.stack);
        res.status(500).json({ error: 'Failed to send uploaded media' });

        // Cleanup file on error too
        if (fs.existsSync(file?.path)) fs.unlinkSync(file.path);
    }
});


app.get('/logout', async (req, res) => {
    const { clientId } = req.query;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    const client = activeClients[clientId];
    if (client) {
        try {
            await client.logout();
            delete activeClients[clientId];
            delete readyClients[clientId];

            db.query('UPDATE clients SET status = "logged_out" WHERE clientId = ?', [clientId], (err) => {
                if (err) console.error('MySQL update error:', err.stack);
            });

            res.status(200).json({ message: `Client ${clientId} logged out` });
        } catch (error) {
            console.error('Logout error:', error);
            res.status(500).json({ error: 'Failed to log out client' });
        }
    } else {
        res.status(404).json({ error: `Client ${clientId} not found or not ready` });
    }
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});
