const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const bodyParser = require('body-parser');
const qr = require('qr-image');
const { PrismaClient } = require("./generated/client");
const prisma = new PrismaClient();
const cors = require('cors');
const app = express();
const port = process.env.PORT || 781;
app.use(cors({
    origin: '', 
    methods: ['GET', 'POST']
}));
app.use(bodyParser.json());

const activeClients = {};

app.get('/initialize-client', async (req, res) => {
    const { clientId } = req.query;
    const secretKey = req.query.secretKey;
    if (!secretKey || secretKey !== process.env.SECRET_KEY) {
        return res.status(401).json({ error: 'Unauthorized. Invalid secret key.' });
    }

    try {
        const existingClient = await prisma.qRCode.findFirst({
            where: { clientId, status: 1 },
        });

        if (existingClient) {
            res.status(400).json({ error: `Client ${clientId} already initialized` });
            return;
        }

        const existingQRCode = await prisma.qRCode.findFirst({
            where: { clientId },
        });

        const client = new Client({
            qrMaxRetries: 1,
            authStrategy: new LocalAuth({ clientId: clientId }),
            restartOnAuthFail: true,
            webVersion: "2.2412.54",
            webVersionCache: {
                type: "remote",
                remotePath:
                    "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
            },
     
            puppeteer: {
                headless: true,
               // args: ["--no-sandbox",'--proxy-server=147.185.238.169:50002']
                // args: ["--no-sandbox",'--proxy-server=46.166.137.38:31499']
            }
        });

        client.initialize([clientId]);

        let updatedQRCode;

        client.on('qr', async (qrCode) => {
            if (existingQRCode) {
                updatedQRCode = await prisma.qRCode.update({
                    where: { id: existingQRCode.id },
                    data: { qrCode }
                });
            } else {
                updatedQRCode = await prisma.qRCode.create({
                    data: { clientId, qrCode, status: 0 }
                });
            }

            console.log(`QR RECEIVED for ${clientId}`, qrCode);
            const qrImage = qr.image(qrCode, { type: 'png' });
            qrImage.pipe(res, { end: true });
        });

        client.on('ready', async () => {
            const user = client.info.me.user;
            console.log('User:', user);
            console.log(`Client is ready for ${clientId}`);
            await prisma.qRCode.update({
                where: { id: updatedQRCode.id },
                data: { status: 1, phone_number: user }
            });
            activeClients[clientId] = client;
        });

        client.on('authenticated', () => {
            console.error(clientId + ' authenticated');
        });

        client.on('auth_failure', () => {
            console.log('auth_failure', );
        });

        client.on('disconnected', async () => {
            await prisma.qRCode.update({
                where: { id: updatedQRCode.id },
                data: { status: 0 }
            });
            delete activeClients[clientId];
        });

        

    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
})


app.get('/status', (req, res, next) => {
    const requestedClientId = req.query.clientId;
    const secretKey = req.query.secretKey;
    if (!secretKey || secretKey !== process.env.SECRET_KEY) {
        return res.status(401).json({ error: 'Unauthorized. Invalid secret key.' });
    }

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

app.get('/message', async (req, res, next) => {
    const requestedClientId = req.query.clientId;
    const number = req.query.to;
    const text = req.query.message;
    const clientPhoneNumber = req.query.clientPhoneNumber;
    const secretKey = req.query.secretKey;
    if (!secretKey || secretKey !== process.env.SECRET_KEY) {
        return res.status(401).json({ error: 'Unauthorized. Invalid secret key.' });
    }
    

    if (!requestedClientId || !number || !text || !clientPhoneNumber) {
        res.status(400).json({ error: 'clientId, number, text and clientPhoneNumber are required in the query parameters' });
        return;
    }
    const client = activeClients[requestedClientId];
    if (client) {
        const user = client.info.me.user
        if (user !== clientPhoneNumber) {
            console.log(`User and client phone number do not match for ${requestedClientId}`);
            res.status(400).json({ error: 'User and client phone number do not match' });
            return;
        
    }
        const chatId = number.substring(1) + "@c.us";
        client.sendMessage(chatId, text);

        try {
            await prisma.messageLog.create({
                data: {
                    clientId: requestedClientId,
                    phoneNumber: number,
                    message: text,
                },
            });
            res.status(200).json({ message: `Client ${requestedClientId} sent message successfully` });
        } catch (error) {
            console.error("Error saving message log:", error);
            res.status(500).json({ error: 'Internal server error' });
        }
    } else {
        res.status(404).json({ error: `Client ${requestedClientId} not found or not ready` });
    }
});



app.get('/logout', (req, res, next) => {
    const requestedClientId = req.query.clientId;

    if (!requestedClientId) {
        res.status(400).json({ error: 'clientId is required in the query parameters' });
        return;
    }

    const client = activeClients[requestedClientId];
    console.log(client);
    
    if (client) {
        client.on('logout', (reason) => {
            // client.destroy();
            console.log(`Client for ${requestedClientId} was logged out`, reason);
            delete activeClients[requestedClientId];
            client.initialize()

        });
    
        res.status(200).json({ message: `Client ${requestedClientId} was logged out` });
    } else {
        res.status(404).json({ error: `Client ${requestedClientId} not found or not ready` });
    }
});

app.listen(port, () => {
    console.log(`Server is running on http://207.244.239.151:${port}`);
});