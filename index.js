// === DEPENDÊNCIAS ===
const http = require('http');
const qrcode = require('qrcode');
const { Client } = require('whatsapp-web.js');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// === CONFIGURAÇÕES ===
console.log('Lendo variáveis de ambiente...');
// As variáveis de ambiente devem ser configuradas no seu serviço Render
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
const geminiApiKey = process.env.GEMINI_API_KEY;
const crmUserId = process.env.CRM_USER_ID; // ID do usuário principal (Admin) para o qual os leads são salvos
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
// Usando 'gemini-pro' para estabilidade ou 'gemini-2.5-flash' se preferir.
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
// SE QUISER USAR A FLASH, MANTENHA: const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 
console.log('✅ Conectado à API do Gemini!');

// === VARIÁVEIS DE ESTADO ===
let qrCodeDataUrl = null;
let botStatus = "Iniciando...";
let clientReady = false;

// === SERVIDOR WEB PARA EXIBIR O QR CODE E RECEBER COMANDOS ===
const server = http.createServer(async (req, res) => {
    // Permite CORS para que o seu SuperApp possa se comunicar com o bot
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Rota para exibir o QR Code ou Status
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
                        <p>Se o QR Code não aparecer em 30 segundos, atualize a página.</p>
                    </div>
                </body>
            `);
        }
        return;
    }

    // Rota para o Super App enviar mensagens
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
const PROMPT_PADRAO_BASE = `Você é um assistente virtual. Sua função é fazer o pré-atendimento. Colete o nome, assunto, orçamento e prazo do cliente. Ao final, retorne um JSON com a chave "finalizado" como true e os dados coletados.`;


client.on('message', async message => {
    const contato = message.from;
    const textoRecebido = message.body;
    console.log(`Mensagem de ${contato}: "${textoRecebido}"`);
    if (message.isGroup) return;

    // 1. Encontrar o Lead e salvar a mensagem
    const leadId = await encontrarOuCriarLead(contato);
    if(leadId) await salvarMensagemNoHistorico(leadId, 'user', textoRecebido);

    // 2. Carregar Prompt do Usuário (e agora, o Estoque!)
    let promptDoUsuario = PROMPT_PADRAO_BASE;
    let estoqueText = "";

    try {
        if (crmUserId) {
            const userDoc = await db.collection('userData').doc(crmUserId).get();
            const userData = userDoc.data();

            // Carrega o prompt de IA salvo pelo cliente no SuperApp
            if (userData && userData.botPrompt) {
                promptDoUsuario = userData.botPrompt;
            }

            // NOVO: Carrega e formata os dados de Estoque
            const estoque = userData.estoque || [];
            if (estoque.length > 0) {
                estoqueText = "INFORMAÇÃO DE ESTOQUE ATUAL: Os produtos disponíveis no momento são: ";
                estoque.forEach(p => {
                    // Assume que 'quantidade' é um campo, senão usará 'Não especificada'
                    const quantidade = p.quantidade !== undefined ? p.quantidade : 'Não especificada';
                    estoqueText += `Produto: ${p.produto} (Preço de Venda: R$${p.venda ? p.venda.toFixed(2) : 'N/A'}, Quantidade: ${quantidade}); `;
                });
                estoqueText += "Use esta informação para responder perguntas sobre produtos e disponibilidade.";
            }

        }
    } catch (error) {
        console.error("Erro ao carregar prompt/estoque do usuário, usando o padrão:", error);
    }

    // 3. Montar o Prompt Final com o Estoque
    const finalPrompt = estoqueText ? `${promptDoUsuario}\n\n${estoqueText}` : promptDoUsuario;
    
    // 4. Iniciar/Continuar Conversa
    if (!conversas[contato]) {
        conversas[contato] = [
            { role: "user", parts: [{ text: finalPrompt }] },
            { role: "model", parts: [{ text: "Ok, entendi minhas instruções e o estoque. Estou pronto para começar." }] }
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
        // Salvando na subcoleção correta: userData/{userId}/leads/{leadId}/messages
        await db.collection('userData').doc(crmUserId).collection('leads').doc(String(leadId)).collection('messages').add(messageData);
    } catch (error) {
        console.error(`Erro ao salvar mensagem para o lead ${leadId}:`, error);
    }
}

async function encontrarOuCriarLead(whatsappNumber) {
    if (!crmUserId) return null;
    const whatsappId = whatsappNumber.replace('@c.us', '');
    const userDocRef = db.collection('userData').doc(crmUserId);
    
    const userDoc = await userDocRef.get();
    let leadsAtuais = userDoc.exists ? (userDoc.data().leads || []) : [];
    
    const leadExistente = leadsAtuais.find(l => l.whatsapp === whatsappId);
    if (leadExistente) {
        return String(leadExistente.id);
    }

    const novoLeadId = leadsAtuais.length > 0 ? Math.max(...leadsAtuais.map(l => l.id)) + 1 : 0;
    const novoLead = {
        id: novoLeadId,
        nome: "Novo Contato",
        whatsapp: whatsappId,
        origem: "WhatsApp",
        status: "novo",
        qualificacao: "",
        notas: "[Lead criado via Bot]",
        email: ""
    };

    leadsAtuais.push(novoLead);
    await userDocRef.set({ leads: leadsAtuais }, { merge: true });
    console.log(`✅ Novo lead criado para ${whatsappId} com ID ${novoLeadId}`);
    return String(novoLeadId);
}

async function atualizarLead(leadId, dadosDoLead) {
    if (!crmUserId) return;
    const userDocRef = db.collection('userData').doc(crmUserId);
    const userDoc = await userDocRef.get();
    
    if (userDoc.exists) {
        let leads = userDoc.data().leads || [];
        const leadIndex = leads.findIndex(l => String(l.id) === String(leadId));

        if (leadIndex > -1) {
            // Atualiza os campos do lead
            leads[leadIndex].nome = dadosDoLead.nome || leads[leadIndex].nome;
            leads[leadIndex].status = "progresso"; // Move o status para progresso após qualificação
            leads[leadIndex].notas = `[Lead atualizado via Bot]\nAssunto: ${dadosDoLead.assunto || "Não informado"}\nOrçamento: ${dadosDoLead.orcamento || "Não informado"}\nPrazo: ${dadosDoLead.prazo || "Não informado"}`;
            await userDocRef.update({ leads });
            console.log(`✅ Lead ${leadId} atualizado com os dados do bot.`);
        }
    }
}

console.log("Iniciando o cliente WhatsApp...");
client.initialize();
