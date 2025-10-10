const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
    console.log("[Firebase] Conectado ao Firebase Admin!");
} catch (error) {
    console.error("[Firebase] ERRO: Verifique a variável de ambiente FIREBASE_SERVICE_ACCOUNT.", error);
}
const db = getFirestore();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.error("ERRO: Variável de ambiente GEMINI_API_KEY não encontrada.");
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const app = express();
app.use(cors());
app.use(express.json());

const port = process.env.PORT || 10000;
const whatsappClients = {};
const frontendConnections = {};

function sendEventToUser(userId, data) {
    if (frontendConnections[userId]) {
        frontendConnections[userId].res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

function createWhatsappClient(userId) {
    console.log(`[Sistema] Criando cliente de WhatsApp para: ${userId}`);
    const client = new Client({ authStrategy: new LocalAuth({ clientId: userId }), puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] } });

    client.on('qr', (qr) => qrcode.toDataURL(qr, (err, url) => sendEventToUser(userId, { type: 'qr', data: url })));
    client.on('ready', () => sendEventToUser(userId, { type: 'status', data: 'Conectado ao WhatsApp!' }));

    client.on('message', async (message) => {
        const userContact = message.from;
        console.log(`[WhatsApp - ${userId}] Mensagem de ${userContact}: ${message.body}`);
        if (message.isStatus || message.from.includes('@g.us') || message.fromMe) return;

        try {
            const userDocRef = db.collection('userData').doc(userId);
            const userDoc = await userDocRef.get();
            if (!userDoc.exists) {
                console.log(`[Sistema - ${userId}] Documento do usuário não encontrado.`);
                return;
            }
            
            let userData = userDoc.data();
            let leads = userData.leads || [];
            let currentLead = leads.find(lead => lead.whatsapp === userContact);
            let leadId;

            // Lógica para não responder se o bot estiver desativado para este lead
            if (currentLead && currentLead.botActive === false) {
                console.log(`[Bot - ${userId}] Bot desativado para o lead ${currentLead.nome}. Ignorando mensagem.`);
                return;
            }

            if (!currentLead) {
                console.log(`[CRM - ${userId}] Novo contato!`);
                const prompt = `Analise a mensagem: "${message.body}". Extraia o nome do remetente. Responda apenas o nome. Se não achar, responda "Novo Contato".`;
                const leadName = (await (await model.generateContent(prompt)).response).text().trim();
                
                const nextId = leads.length > 0 ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1;
                const newLead = { id: nextId, nome: leadName, whatsapp: userContact, status: 'novo', botActive: true }; // Adiciona botActive como true por padrão
                leadId = nextId;
                
                await userDocRef.update({ leads: FieldValue.arrayUnion(newLead) });
                console.log(`[CRM - ${userId}] Novo lead "${leadName}" criado!`);
                currentLead = newLead; // Define o lead atual para salvar o histórico
            } else {
                leadId = currentLead.id;
            }

            await db.collection('userData').doc(userId).collection('leads').doc(String(leadId))
                      .collection('messages').add({ text: message.body, sender: 'lead', timestamp: new Date() });

            const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo.";
            const fullPrompt = `${botInstructions}\n\nMensagem do cliente: "${message.body}"`;
            const aiResponse = (await (await model.generateContent(fullPrompt)).response).text();
            
            await message.reply(aiResponse);

            await db.collection('userData').doc(userId).collection('leads').doc(String(leadId))
                      .collection('messages').add({ text: aiResponse, sender: 'operator', timestamp: new Date() });

        } catch (error) {
            console.error(`[Sistema - ${userId}] Erro no processamento da mensagem:`, error);
        }
    });
    
    client.on('disconnected', (reason) => {
        console.log(`[WhatsApp - ${userId}] Cliente desconectado:`, reason);
        delete whatsappClients[userId];
    });

    client.initialize().catch(err => console.error(`[${userId}] Falha ao inicializar:`, err));
    whatsappClients[userId] = client;
}

app.get('/events', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    frontendConnections[userId] = { res };
    if (!whatsappClients[userId]) createWhatsappClient(userId);
    else sendEventToUser(userId, { type: 'status', data: 'Conexão já estabelecida.' });
    req.on('close', () => delete frontendConnections[userId]);
});

app.listen(port, () => console.log(`[Servidor] Servidor multi-usuário rodando na porta ${port}.`));
