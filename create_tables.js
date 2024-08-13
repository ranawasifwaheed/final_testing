require('dotenv').config(); // Load environment variables from .env file
const mysql = require('mysql2'); // Use mysql2 for database connections

// Create a MySQL connection pool
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// SQL statements to create tables
const createClientsTable = `
CREATE TABLE IF NOT EXISTS clients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    clientId VARCHAR(255) UNIQUE NOT NULL,
    status ENUM('ready', 'disconnected', 'logged_out') NOT NULL,
    status_message TEXT
);`;

const createChatsTable = `
CREATE TABLE IF NOT EXISTS chats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    clientId VARCHAR(255),
    name VARCHAR(255),
    contactNumber VARCHAR(50),
    type ENUM('Group', 'Private')
);`;

const createQRCodesTable = `
CREATE TABLE IF NOT EXISTS qrcodes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    clientId VARCHAR(255) NOT NULL,
    qrCode TEXT,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

const createMessageLogTable = `
CREATE TABLE IF NOT EXISTS message_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    clientId VARCHAR(255),
    number VARCHAR(50),
    message TEXT,
    sentAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);`;

const createContactsTable = `
CREATE TABLE IF NOT EXISTS contacts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    clientId VARCHAR(255),
    name VARCHAR(255),
    contactNumber VARCHAR(50),
    type ENUM('Group', 'Private')
);`;

// Function to create tables
const createTables = () => {
    db.query(createClientsTable, (err, results) => {
        if (err) {
            console.error('Error creating clients table:', err);
        } else {
            console.log('Clients table created successfully');
        }
    });

    db.query(createChatsTable, (err, results) => {
        if (err) {
            console.error('Error creating chats table:', err);
        } else {
            console.log('Chats table created successfully');
        }
    });

    db.query(createQRCodesTable, (err, results) => {
        if (err) {
            console.error('Error creating qrcodes table:', err);
        } else {
            console.log('QRCodes table created successfully');
        }
    });

    db.query(createMessageLogTable, (err, results) => {
        if (err) {
            console.error('Error creating message log table:', err);
        } else {
            console.log('Message Log table created successfully');
        }
    });

    db.query(createContactsTable, (err, results) => {
        if (err) {
            console.error('Error creating contacts table:', err);
        } else {
            console.log('Contacts table created successfully');
        }
    });

};

// Call the function to create tables
createTables();
