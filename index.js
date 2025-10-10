// === DEPENDÊNCIAS ===
const http = require('http');
const qrcode = require('qrcode');
const { Client } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// === CONFIGURAÇÕES ===
console.log('Lendo variáveis de ambiente...');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
const geminiApiKey = process.env.GEMINI_API_KEY;
const crmUserId = process.env.CRM_USER_ID;
console.log('Variáveis lidas com sucesso.');

// Inicializa Firebase
try {
    if (admin.apps.length === 0) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: `https://${firebaseConfig.projectId}.firebaseio.com`
        });
        console.log('✅ Conectado ao Firebase!');
    }
} catch (error) {
    console.error('❌ ERRO AO CONECTAR COM FIREBASE:', error);
    process.exit(1);
}
const db = admin.firestore();

// Inicializa Gemini
const genAI = new GoogleGenerativeAI(geminiApiKey);
// Alterado para 'gemini-2.5-flash' conforme solicitado
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
console.log('✅ Conectado à API do Gemini!');

// === VARIÁVEIS DE ESTADO ===
let qrCodeDataUrl = null;
let botStatus = "Iniciando...";
let clientReady = false;

// === SERVIDOR WEB PARA EXIBIR O QR CODE E RECEBER COMANDOS ===
const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.url === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (qrCodeDataUrl) {
            res.end(`
                <body style="background-color: #1a1a2e;">
                    <div style="font-family: sans-serif; text-align: center; padding: 40px; color: #cdd6f4;">
                        <h1>Escaneie para Conectar</h1>
                        <p>Abra o WhatsApp no seu celular e escaneie a imagem abaixo.</p>
                        <img src="${qrCodeDataUrl}" alt="QR Code do WhatsApp" style="width: 300px; height: 300px; background-color: white; padding: 10px; border-radius: 8px;">
                        <p style="margin-top: 20px;">Após escanear, esta página será atualizada com a mensagem de confirmação.</p>
                    </div>
                </body>
            `);
        } else {
            res.end(`
                <body style="background-color: #1a1a2e;">
                    <div style="font-family: sans-serif; text-align: center; padding: 40px; color: #cdd6f4;">
                        <h1>SuperApp WhatsApp Bot</h1>
                        <p><strong>Status:</strong> ${botStatus}</p>
                        <p>Se o QR Code não aparecer em 30 segundos, atualize a página. Se o status for 'Desconectado', reinicie o serviço no painel da Render.</p>
                    </div>
                </body>
            `);
        }
        return;
    }

    if (req.url === '/send-message' && req.method === 'POST') {
        if (!clientReady) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Cliente WhatsApp não está pronto.' }));
            return;
        }
        
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { number, message, leadId } = JSON.parse(body);
                if (!number || !message || !leadId) {
                    throw new Error('Número, mensagem e leadId são necessários.');
                }
                
                const chatId = `${number}@c.us`;
                await client.sendMessage(chatId, message);
                await salvarMensagemNoHistorico(leadId, 'operator', message);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
                console.log(`Mensagem manual enviada para ${number} pelo CRM.`);

            } catch (error) {
                console.error("Erro ao enviar mensagem manual:", error);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: error.message }));
            }
        });
        return;
    }

    res.writeHead(404).end();
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`✅ Servidor web rodando na porta ${PORT}.`); });

// === BOT DO WHATSAPP ===
const client = new Client({ puppeteer: { headless: true, args: [ '--no-sandbox', '--disable-setuid-sandbox' ] } });

client.on('qr', async (qr) => {
    console.log("QR Code recebido, gerando imagem...");
    botStatus = "Aguardando escaneamento do QR Code.";
    qrCodeDataUrl = await qrcode.toDataURL(qr);
});

client.on('ready', () => { 
    clientReady = true; 
    botStatus = "Conectado com sucesso! O bot já está funcionando.";
    qrCodeDataUrl = null; 
    console.log('✅ Cliente WhatsApp conectado e pronto para trabalhar!'); 
});

client.on('disconnected', (reason) => { 
    clientReady = false;
    botStatus = `Desconectado: ${reason}. Reiniciando...`;
    console.log('❌ Cliente foi desconectado!', reason);
    client.initialize();
});

const conversas = {};
const PROMPT_PADRAO = `Você é um assistente virtual. Sua função é fazer o pré-atendimento. Colete o nome, assunto, orçamento e prazo do cliente. Ao final, retorne um JSON com a chave "finalizado" como true e os dados coletados.`;

client.on('message', async message => {
    const contato = message.from;
    const textoRecebido = message.body;
    console.log(`Mensagem de ${contato}: "${textoRecebido}"`);
    if (message.isGroup) return;

    const leadId = await encontrarOuCriarLead(contato);
    if(leadId) await salvarMensagemNoHistorico(leadId, 'user', textoRecebido);

    let promptDoUsuario = PROMPT_PADRAO;
    try {
        if (crmUserId) {
            const userDoc = await db.collection('users').doc(crmUserId).get();
            if (userDoc.exists && userDoc.data().botPrompt) {
                promptDoUsuario = userDoc.data().botPrompt;
            }
        }
    } catch (error) {
        console.error("Erro ao carregar prompt do usuário, usando o padrão:", error);
    }

    if (!conversas[contato]) {
        conversas[contato] = [
            { role: "user", parts: [{ text: promptDoUsuario }] },
            { role: "model", parts: [{ text: "Ok, entendi minhas instruções. Estou pronto para começar." }] }
        ];
    }
    
    conversas[contato].push({ role: "user", parts: [{ text: textoRecebido }] });

    try {
        const result = await geminiModel.generateContent({ contents: conversas[contato] });
        const respostaIA = result.response.text();
        console.log(`Resposta da IA: "${respostaIA}"`);
        
        conversas[contato].push({ role: "model", parts: [{ text: respostaIA }] });

        let dadosExtraidos;
        try {
            dadosExtraidos = JSON.parse(respostaIA);
        } catch (e) {
            await client.sendMessage(contato, respostaIA);
            if(leadId) await salvarMensagemNoHistorico(leadId, 'bot', respostaIA);
            return;
        }

        if (dadosExtraidos && dadosExtraidos.finalizado === true) {
            console.log("Conversa finalizada. Atualizando lead no CRM...");
            const leadData = dadosExtraidos.dados_cliente || dadosExtraidos;
            leadData.whatsapp = contato.replace('@c.us', '');
            
            await atualizarLead(leadId, leadData);
            
            const msgFinal = `Obrigado, ${leadData.nome}! Recebi suas informações. Um de nossos especialistas entrará em contato em breve para falar sobre seu projeto de "${leadData.assunto}".`;
            await client.sendMessage(contato, msgFinal);
            if(leadId) await salvarMensagemNoHistorico(leadId, 'bot', msgFinal);
            delete conversas[contato];
        }
    } catch (error) {
        console.error("❌ Erro na comunicação com o Gemini:", error);
        conversas[contato].pop();
        await client.sendMessage(contato, "Desculpe, estou com um problema técnico no momento. Tente novamente mais tarde.");
    }
});

// === FUNÇÕES DO BANCO DE DADOS ===

async function salvarMensagemNoHistorico(leadId, sender, text) {
    if (!crmUserId || !leadId) return;
    try {
        const messageData = {
            sender, text, timestamp: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('users').doc(crmUserId).collection('leads').doc(leadId).collection('messages').add(messageData);
    } catch (error) {
        console.error(`Erro ao salvar mensagem para o lead ${leadId}:`, error);
    }
}

async function encontrarOuCriarLead(whatsappNumber) {
    if (!crmUserId) return null;
    const whatsappId = whatsappNumber.replace('@c.us', '');
    const leadsCollection = db.collection('users').doc(crmUserId).collection('leads');
    const snapshot = await leadsCollection.where('whatsapp', '==', whatsappId).limit(1).get();
    
    if (!snapshot.empty) {
        return snapshot.docs[0].id;
    }

    const novoLead = {
        nome: "Novo Contato", whatsapp: whatsappId, origem: "WhatsApp", status: "novo"
    };
    const newDocRef = await leadsCollection.add(novoLead);
    console.log(`✅ Novo lead criado para ${whatsappId} com ID ${newDocRef.id}`);
    return newDocRef.id;
}

async function atualizarLead(leadId, dadosDoLead) {
    if (!crmUserId || !leadId) return;
    const leadRef = db.collection('users').doc(crmUserId).collection('leads').doc(leadId);
    const leadUpdateData = {
        nome: dadosDoLead.nome,
        notas: `[Lead atualizado via Bot]\nAssunto: ${dadosDoLead.assunto}\nOrçamento: ${dadosDoLead.orcamento}\nPrazo: ${dadosDoLead.prazo}`
    };
    await leadRef.update(leadUpdateData);
    console.log(`✅ Lead ${leadId} atualizado com os dados do bot.`);
}

console.log("Iniciando o cliente WhatsApp...");
client.initialize();

const express = require('express');
const cors = require('cors');
const app = express();

// Adicione esta linha para permitir conexões de qualquer origem
app.use(cors()); 

// O resto do seu código continua aqui...
