/**
 * =====================================================
 * BOT WHATSAPP COMPLETO - SUPERAPP MEU CARRO ONLINE
 * =====================================================
 * 
 * ATUALIZADO: Compatível com estrutura atual do bot no Render
 * 
 * INSTRUÇÕES:
 * 1. Substitua TODO o conteúdo do arquivo index.js no repositório superapp-whatsapp-bot
 * 2. Faça commit e push para o GitHub
 * 3. O Render vai fazer deploy automaticamente
 * 4. Após deploy, acesse o Painel Admin > Conexão WhatsApp e escaneie o QR Code
 * 
 * Funcionalidades:
 * ✅ Pré-atendimento automático com IA
 * ✅ Menu interativo principal
 * ✅ Distribuição de leads entre vendedores (rodízio)
 * ✅ Sistema de avaliação de carros de troca
 * ✅ Baixa de veículo vendido (lojista)
 * ✅ Sincronização com Supabase via webhook
 */

const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// ========== CONFIGURAÇÕES ==========
const PORT = process.env.PORT || 3000;
const SUPABASE_WEBHOOK_URL = 'https://qcrnetcdkfwtgphsezoo.supabase.co/functions/v1/bot-webhook';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjcm5ldGNka2Z3dGdwaHNlem9vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk1NDY0OTgsImV4cCI6MjA4NTEyMjQ5OH0.el2SaXnxVUNSlyrmohMRqaseurQieohKj6d2W3XAAWU';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// ========== ESTADO DO BOT ==========
const sessions = new Map(); // userId -> { sock, qrCode, status, authState }
const userConversations = new Map(); // jid -> { state, data, lastMessage }

// ========== HELPER: CHAMAR WEBHOOK SUPABASE ==========
async function callSupabaseWebhook(action, userId, data) {
  try {
    console.log(`[WEBHOOK] Calling ${action} for user ${userId}`);
    
    const response = await fetch(SUPABASE_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ action, userId, data })
    });

    const result = await response.json();
    
    if (!response.ok) {
      console.error(`[WEBHOOK] Error: ${result.error}`);
      return { success: false, error: result.error };
    }

    console.log(`[WEBHOOK] Success:`, result);
    return { success: true, ...result };
  } catch (error) {
    console.error(`[WEBHOOK] Exception:`, error.message);
    return { success: false, error: error.message };
  }
}

// ========== HELPER: GEMINI AI CHAT ==========
async function getAIResponse(messages, systemPrompt) {
  if (!GEMINI_API_KEY) {
    console.log('[AI] GEMINI_API_KEY não configurada');
    return null;
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: systemPrompt + '\n\nMensagem do cliente: ' + messages[messages.length - 1]?.content }] }
        ],
        generationConfig: {
          maxOutputTokens: 500,
          temperature: 0.7
        }
      })
    });

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (error) {
    console.error('[AI] Error:', error.message);
    return null;
  }
}

// ========== SISTEMA DE MENU ==========
const MENU_PRINCIPAL = `🚗 *Meu Carro Online - Central*

Olá! Como posso ajudar?

1️⃣ Quero ver carros disponíveis
2️⃣ Tenho interesse em um carro
3️⃣ Quero avaliar meu carro para troca
4️⃣ Falar com um vendedor
5️⃣ Sou lojista - Reportar venda

Digite o número da opção:`;

const MENU_AVALIACAO = `📋 *Avaliação de Carro para Troca*

Para avaliar seu carro, preciso de algumas informações:

1. Qual carro da nossa loja você tem interesse?
2. Dados do seu carro (modelo, ano, km)
3. Fotos do seu carro (opcional)

Vamos começar! Qual é o *modelo e ano* do carro que você quer comprar?
(Ex: Civic 2020)`;

const MENU_BAIXA_LOJISTA = `📝 *Baixa de Veículo Vendido*

Para registrar a venda, preciso de:

1️⃣ Qual carro foi vendido? (Modelo e Ano)
2️⃣ Nome do comprador
3️⃣ CPF do comprador
4️⃣ Teve carro na troca? (Sim/Não)
5️⃣ Canal de venda: Meu Carro Online ou Outros?

Vamos começar! Qual carro foi vendido?
(Ex: Corolla 2019)`;

// ========== ESTADOS DA CONVERSA ==========
const CONVERSATION_STATES = {
  IDLE: 'idle',
  MENU_PRINCIPAL: 'menu_principal',
  AVALIACAO_CARRO_INTERESSE: 'avaliacao_carro_interesse',
  AVALIACAO_DADOS_TROCA: 'avaliacao_dados_troca',
  AVALIACAO_FOTOS: 'avaliacao_fotos',
  AVALIACAO_CONFIRMAR: 'avaliacao_confirmar',
  BAIXA_CARRO_VENDIDO: 'baixa_carro_vendido',
  BAIXA_COMPRADOR_NOME: 'baixa_comprador_nome',
  BAIXA_COMPRADOR_CPF: 'baixa_comprador_cpf',
  BAIXA_TEVE_TROCA: 'baixa_teve_troca',
  BAIXA_CANAL_VENDA: 'baixa_canal_venda',
  AGUARDANDO_HUMANO: 'aguardando_humano'
};

// ========== HANDLER PRINCIPAL DE MENSAGENS ==========
async function handleMessage(sock, userId, msg) {
  const jid = msg.key.remoteJid;
  const isFromMe = msg.key.fromMe;
  const text = msg.message?.conversation || 
               msg.message?.extendedTextMessage?.text || 
               msg.message?.imageMessage?.caption || '';
  const isImage = !!msg.message?.imageMessage;
  
  if (!jid || jid.includes('status@broadcast')) return;
  
  const contactName = msg.pushName || jid.split('@')[0];
  console.log(`[MSG] ${isFromMe ? 'OUT' : 'IN'} | ${jid} | ${text.slice(0, 50)}...`);

  // Ignorar mensagens enviadas por nós
  if (isFromMe) return;

  // Buscar/criar estado da conversa
  let conv = userConversations.get(jid) || { 
    state: CONVERSATION_STATES.IDLE, 
    data: {},
    lastMessage: Date.now()
  };

  // Reset se passou mais de 1 hora
  if (Date.now() - conv.lastMessage > 3600000) {
    conv = { state: CONVERSATION_STATES.IDLE, data: {}, lastMessage: Date.now() };
  }
  conv.lastMessage = Date.now();

  // Sincronizar lead com Supabase
  const leadResult = await callSupabaseWebhook('new_lead', userId, {
    nome: contactName,
    whatsapp: jid,
    status: 'novo',
    botActive: true
  });
  const leadId = leadResult.leadId;

  // Salvar mensagem recebida
  await callSupabaseWebhook('save_message', userId, {
    leadId,
    whatsapp: jid,
    text,
    isFromMe: false,
    contactName
  });

  let response = '';

  // ========== MÁQUINA DE ESTADOS ==========
  switch (conv.state) {
    case CONVERSATION_STATES.IDLE:
      // Primeira mensagem - mostrar menu
      response = MENU_PRINCIPAL;
      conv.state = CONVERSATION_STATES.MENU_PRINCIPAL;
      break;

    case CONVERSATION_STATES.MENU_PRINCIPAL:
      const option = text.trim();
      
      if (option === '1') {
        // Listar carros disponíveis
        const veiculosResult = await callSupabaseWebhook('list_veiculos', userId, {});
        if (veiculosResult.veiculos?.length > 0) {
          response = '🚗 *Carros Disponíveis:*\n\n';
          veiculosResult.veiculos.slice(0, 5).forEach((v, i) => {
            response += `${i + 1}. *${v.modelo}* ${v.ano}\n   💰 R$ ${v.preco}\n   📍 ${v.km || '0'} km\n\n`;
          });
          response += 'Tem interesse em algum? Digite o número ou "menu" para voltar.';
        } else {
          response = 'No momento não temos carros cadastrados. Digite "menu" para voltar.';
        }
      }
      else if (option === '2') {
        response = 'Ótimo! Qual carro você tem interesse? Me diz o modelo e ano que vou verificar a disponibilidade.';
        conv.state = CONVERSATION_STATES.AGUARDANDO_HUMANO;
      }
      else if (option === '3') {
        response = MENU_AVALIACAO;
        conv.state = CONVERSATION_STATES.AVALIACAO_CARRO_INTERESSE;
        conv.data = { vendedorWhatsapp: jid, vendedorNome: contactName };
      }
      else if (option === '4') {
        response = 'Vou transferir você para um de nossos vendedores. Aguarde um momento! 🙏';
        conv.state = CONVERSATION_STATES.AGUARDANDO_HUMANO;
        // Desativar bot para este lead
        await callSupabaseWebhook('update_lead', userId, { leadId, botActive: false });
      }
      else if (option === '5') {
        response = MENU_BAIXA_LOJISTA;
        conv.state = CONVERSATION_STATES.BAIXA_CARRO_VENDIDO;
        conv.data = {};
      }
      else {
        // Usar IA para responder
        const aiResponse = await getAIResponse(
          [{ role: 'user', content: text }],
          `Você é um assistente de uma loja de carros chamada "Meu Carro Online". Responda brevemente e ofereça o menu de opções:
          1. Ver carros disponíveis
          2. Interesse em um carro
          3. Avaliar carro para troca
          4. Falar com vendedor
          5. Sou lojista - Reportar venda`
        );
        response = aiResponse || MENU_PRINCIPAL;
      }
      break;

    // ========== FLUXO DE AVALIAÇÃO ==========
    case CONVERSATION_STATES.AVALIACAO_CARRO_INTERESSE:
      conv.data.veiculoInteresse = text;
      // Parsear modelo e ano
      const match = text.match(/(.+?)\s*(\d{4})/i);
      if (match) {
        conv.data.veiculoModelo = match[1].trim();
        conv.data.veiculoAno = match[2];
      } else {
        conv.data.veiculoModelo = text;
        conv.data.veiculoAno = '';
      }
      
      response = `Entendi! Você tem interesse no *${text}*.\n\nAgora me conta sobre o seu carro para troca:\n- Modelo\n- Ano\n- Quilometragem\n- Valor FIPE (se souber)\n\n(Ex: Gol 2018, 45.000km, FIPE R$ 35.000)`;
      conv.state = CONVERSATION_STATES.AVALIACAO_DADOS_TROCA;
      break;

    case CONVERSATION_STATES.AVALIACAO_DADOS_TROCA:
      conv.data.dadosTroca = text;
      // Parsear dados
      const trocaMatch = text.match(/(.+?)\s*(\d{4})/i);
      conv.data.trocaModelo = trocaMatch ? trocaMatch[1].trim() : text;
      conv.data.trocaAno = trocaMatch ? trocaMatch[2] : '';
      
      const kmMatch = text.match(/(\d{1,3}(?:\.\d{3})*|\d+)\s*km/i);
      conv.data.trocaKm = kmMatch ? kmMatch[1].replace(/\./g, '') : '';
      
      const fipeMatch = text.match(/(?:fipe|R\$)\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/i);
      conv.data.trocaValorFipe = fipeMatch ? fipeMatch[1] : '';
      
      response = `Perfeito! Recebi os dados:\n- Modelo: ${conv.data.trocaModelo}\n- Ano: ${conv.data.trocaAno || 'não informado'}\n- KM: ${conv.data.trocaKm || 'não informado'}\n\n📸 Agora envie fotos do seu carro (frente, lateral, interior) ou digite "pular" para continuar sem fotos.`;
      conv.state = CONVERSATION_STATES.AVALIACAO_FOTOS;
      conv.data.fotos = [];
      break;

    case CONVERSATION_STATES.AVALIACAO_FOTOS:
      if (isImage) {
        conv.data.fotos.push('foto_recebida'); // Em produção, salvar a URL
        response = `✅ Foto recebida! (${conv.data.fotos.length}/5)\n\nEnvie mais fotos ou digite "pronto" para finalizar.`;
      } else if (text.toLowerCase() === 'pular' || text.toLowerCase() === 'pronto') {
        response = `📋 *Resumo da Avaliação:*\n\n` +
          `Interesse: *${conv.data.veiculoInteresse}*\n` +
          `Troca: *${conv.data.trocaModelo} ${conv.data.trocaAno}*\n` +
          `KM: ${conv.data.trocaKm || 'N/I'}\n` +
          `Fotos: ${conv.data.fotos.length}\n\n` +
          `Digite "confirmar" para enviar ou "cancelar" para refazer.`;
        conv.state = CONVERSATION_STATES.AVALIACAO_CONFIRMAR;
      } else {
        response = 'Envie uma foto ou digite "pular" para continuar.';
      }
      break;

    case CONVERSATION_STATES.AVALIACAO_CONFIRMAR:
      if (text.toLowerCase() === 'confirmar') {
        // Enviar para o webhook criar avaliação
        const avalResult = await callSupabaseWebhook('create_avaliacao', userId, {
          vendedorWhatsapp: conv.data.vendedorWhatsapp,
          vendedorNome: conv.data.vendedorNome,
          clienteNome: contactName,
          clienteWhatsapp: jid,
          veiculoModelo: conv.data.veiculoModelo,
          veiculoAno: conv.data.veiculoAno || '2024',
          trocaModelo: conv.data.trocaModelo,
          trocaAno: conv.data.trocaAno || '2020',
          trocaKm: conv.data.trocaKm || '',
          trocaValorFipe: conv.data.trocaValorFipe || '',
          trocaFotos: conv.data.fotos
        });

        if (avalResult.success) {
          response = `✅ *Solicitação de avaliação enviada!*\n\n` +
            `Encontramos o veículo: ${avalResult.veiculoEncontrado || conv.data.veiculoInteresse}\n` +
            `A loja ${avalResult.lojistaNome || 'parceira'} irá avaliar e responder em breve!\n\n` +
            `Você receberá a resposta aqui mesmo. 🚗`;
          
          // Notificar lojista (se tiver WhatsApp)
          if (avalResult.lojistaWhatsapp) {
            const msgLojista = `🔔 *Nova Solicitação de Avaliação*\n\n` +
              `Vendedor: ${conv.data.vendedorNome}\n` +
              `Interesse: ${conv.data.veiculoInteresse}\n\n` +
              `Troca: ${conv.data.trocaModelo} ${conv.data.trocaAno}\n` +
              `KM: ${conv.data.trocaKm || 'N/I'}\n` +
              `FIPE: ${conv.data.trocaValorFipe || 'N/I'}\n\n` +
              `Responda com o valor da avaliação ou acesse o painel.`;
            
            try {
              await sock.sendMessage(`${avalResult.lojistaWhatsapp}@s.whatsapp.net`, { text: msgLojista });
            } catch (e) {
              console.error('[MSG] Erro ao notificar lojista:', e.message);
            }
          }
        } else {
          response = `❌ Não encontrei o veículo "${conv.data.veiculoInteresse}" na vitrine.\n\nVocê pode tentar outro modelo ou digitar "menu" para ver os carros disponíveis.`;
        }
        
        conv.state = CONVERSATION_STATES.IDLE;
        conv.data = {};
      } else {
        response = 'Avaliação cancelada. Digite "menu" para recomeçar.';
        conv.state = CONVERSATION_STATES.IDLE;
        conv.data = {};
      }
      break;

    // ========== FLUXO DE BAIXA DE VEÍCULO (LOJISTA) ==========
    case CONVERSATION_STATES.BAIXA_CARRO_VENDIDO:
      conv.data.veiculoVendido = text;
      response = 'Qual o *nome completo* do comprador?';
      conv.state = CONVERSATION_STATES.BAIXA_COMPRADOR_NOME;
      break;

    case CONVERSATION_STATES.BAIXA_COMPRADOR_NOME:
      conv.data.compradorNome = text;
      response = 'Qual o *CPF* do comprador?';
      conv.state = CONVERSATION_STATES.BAIXA_COMPRADOR_CPF;
      break;

    case CONVERSATION_STATES.BAIXA_COMPRADOR_CPF:
      conv.data.compradorCPF = text;
      response = 'Teve *carro na troca*?\n\n1️⃣ Sim\n2️⃣ Não';
      conv.state = CONVERSATION_STATES.BAIXA_TEVE_TROCA;
      break;

    case CONVERSATION_STATES.BAIXA_TEVE_TROCA:
      conv.data.teveTroca = text === '1' || text.toLowerCase().includes('sim');
      response = 'Por qual *canal* foi a venda?\n\n1️⃣ Meu Carro Online\n2️⃣ Outros';
      conv.state = CONVERSATION_STATES.BAIXA_CANAL_VENDA;
      break;

    case CONVERSATION_STATES.BAIXA_CANAL_VENDA:
      conv.data.canalVenda = text === '1' ? 'meu_carro_online' : 'outros';
      
      // Enviar para webhook
      const vendaResult = await callSupabaseWebhook('veiculo_vendido', userId, {
        lojaId: userId,
        veiculo: { 
          modelo: conv.data.veiculoVendido, 
          ano: '', 
          preco: '' 
        },
        comprador: { 
          nome: conv.data.compradorNome, 
          cpf: conv.data.compradorCPF 
        },
        teveTroca: conv.data.teveTroca,
        canalVenda: conv.data.canalVenda
      });

      response = `✅ *Venda Registrada!*\n\n` +
        `Veículo: ${conv.data.veiculoVendido}\n` +
        `Comprador: ${conv.data.compradorNome}\n` +
        `CPF: ${conv.data.compradorCPF}\n` +
        `Troca: ${conv.data.teveTroca ? 'Sim' : 'Não'}\n` +
        `Canal: ${conv.data.canalVenda === 'meu_carro_online' ? 'Meu Carro Online' : 'Outros'}\n\n` +
        `A central foi notificada. Obrigado! 🎉`;
      
      conv.state = CONVERSATION_STATES.IDLE;
      conv.data = {};
      break;

    case CONVERSATION_STATES.AGUARDANDO_HUMANO:
      // Bot desativado, não responder
      console.log(`[BOT] Aguardando humano para ${jid}`);
      return;

    default:
      if (text.toLowerCase() === 'menu') {
        response = MENU_PRINCIPAL;
        conv.state = CONVERSATION_STATES.MENU_PRINCIPAL;
      } else {
        response = 'Não entendi. Digite "menu" para ver as opções.';
      }
  }

  // Salvar estado da conversa
  userConversations.set(jid, conv);

  // Enviar resposta
  if (response) {
    try {
      await sock.sendMessage(jid, { text: response });
      
      // Salvar mensagem enviada
      await callSupabaseWebhook('save_message', userId, {
        leadId,
        whatsapp: jid,
        text: response,
        isFromMe: true,
        contactName: 'Bot'
      });
    } catch (error) {
      console.error('[MSG] Erro ao enviar:', error.message);
    }
  }
}

// ========== CRIAR/CONECTAR SESSÃO ==========
async function createSession(userId) {
  console.log(`[SESSION] Creating for ${userId}`);
  
  const authDir = `./auth_${userId}`;
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  
  const { version } = await fetchLatestBaileysVersion();
  
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' })
  });

  const session = {
    sock,
    qrCode: null,
    status: 'connecting',
    user: null
  };
  sessions.set(userId, session);

  // Eventos de conexão
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qrCode = await QRCode.toDataURL(qr);
      session.status = 'QR_AVAILABLE';
      console.log(`[QR] Generated for ${userId}`);
    }

    if (connection === 'open') {
      session.status = 'CONNECTED';
      session.qrCode = null;
      session.user = sock.user?.id || sock.user?.name;
      console.log(`[CONNECTED] ${userId} as ${session.user}`);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      session.status = 'CLOSED';
      console.log(`[DISCONNECTED] ${userId} - Code: ${statusCode}`);
      
      if (shouldReconnect) {
        setTimeout(() => createSession(userId), 5000);
      } else {
        sessions.delete(userId);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Listener de mensagens
  sock.ev.on('messages.upsert', async (m) => {
    for (const msg of m.messages) {
      await handleMessage(sock, userId, msg);
    }
  });

  return session;
}

// ========== ENDPOINTS DA API ==========

// Health check (raiz)
app.get('/', (req, res) => {
  res.json({ 
    status: 'Bot está ativo. Migrado para Baileys.',
    sessions: sessions.size,
    uptime: process.uptime()
  });
});

// Status da conexão
app.get('/status', async (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ error: 'userId required' });
  }

  let session = sessions.get(userId);
  
  if (!session) {
    session = await createSession(userId);
  }

  // Formato compatível com o frontend
  res.json({
    connected: session.status === 'CONNECTED',
    status: session.status,
    qrCodeUrl: session.qrCode,
    user: session.user || 'Dispositivo'
  });
});

// Enviar mensagem
app.post('/send', async (req, res) => {
  const { to, text, userId, leadId } = req.body;

  if (!to || !text || !userId) {
    return res.status(400).json({ error: 'to, text, and userId required' });
  }

  const session = sessions.get(userId);
  
  if (!session || session.status !== 'CONNECTED') {
    return res.status(400).json({ error: 'Not connected' });
  }

  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await session.sock.sendMessage(jid, { text });

    // Salvar no Supabase
    await callSupabaseWebhook('save_message', userId, {
      leadId: leadId || 0,
      whatsapp: jid,
      text,
      isFromMe: true,
      contactName: 'Vendedor'
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SSE Events (para atualização em tempo real do QR)
app.get('/events', async (req, res) => {
  const { userId } = req.query;
  
  if (!userId) {
    return res.status(400).json({ error: 'userId required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  let session = sessions.get(userId);
  if (!session) {
    session = await createSession(userId);
  }

  // Enviar estado atual
  const sendStatus = () => {
    const data = {
      type: session.qrCode ? 'qr' : 'status',
      data: session.qrCode || null,
      connected: session.status === 'CONNECTED',
      user: session.user
    };
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendStatus();

  // Atualizar a cada 3 segundos
  const interval = setInterval(() => {
    session = sessions.get(userId);
    if (session) {
      sendStatus();
    }
  }, 3000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// Desconectar
app.post('/disconnect', async (req, res) => {
  const { userId } = req.body;

  const session = sessions.get(userId);
  if (session?.sock) {
    await session.sock.logout();
    sessions.delete(userId);
  }

  res.json({ success: true });
});

// Health check alternativo
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    sessions: sessions.size,
    uptime: process.uptime()
  });
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`🚀 WhatsApp Bot running on port ${PORT}`);
  console.log(`📡 Webhook: ${SUPABASE_WEBHOOK_URL}`);
});

// URL do webhook Supabase
const WEBHOOK_URL = 'https://qcrnetcdkfwtgphsezoo.supabase.co/functions/v1/bot-webhook';

async function callWebhook(action, userId, data) {
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, userId, data })
    });
    const result = await response.json();
    console.log(`Webhook ${action}:`, result);
    return result;
  } catch (error) {
    console.error(`Webhook ${action} error:`, error);
    return null;
  }
}
// index.js CORRIGIDO COM ESTOQUE E GEMINI 2.5 FLASH
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    makeInMemoryStore, 
    DisconnectReason 
} = require('@whiskeysockets/baileys');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const pino = require('pino');

// --- Configuração do Firebase Admin ---
let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
    db = getFirestore();
    console.log("[Firebase] Conectado ao Firebase Admin!");
} catch (error) {
    console.error("[Firebase] ERRO: Verifique a variável de ambiente FIREBASE_SERVICE_ACCOUNT.", error);
}

// --- Configuração da IA ---
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) console.error("ERRO: Variável de ambiente GEMINI_API_KEY não encontrada.");
const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); // MODELO ESPECIFICADO: gemini-2.5-flash
console.log("[IA] Modelo Gemini 2.5 Flash configurado.");

// --- Configuração do Servidor Express ---
const app = express();
app.use(cors({ origin: true })); 
app.use(express.json());

const port = process.env.PORT || 10000;
const whatsappClients = {};
const frontendConnections = {};
const qrCodeDataStore = {}; 
const store = makeInMemoryStore(pino({ level: 'silent' }).child({ level: 'silent', stream: 'store' }));

function sendEventToUser(userId, data) {
    if (frontendConnections[userId]) {
        frontendConnections[userId].res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
}

// --- Funções do Sistema Baileys ---

function deleteAuthFiles(userId) {
    const authPath = path.join(process.cwd(), `baileys_auth_${userId}`);
    console.log(`[Sistema] Tentando deletar arquivos de autenticação para ${userId}: ${authPath}`);
    try {
        fs.rmSync(authPath, { recursive: true, force: true });
        console.log(`[Sistema] Arquivos de autenticação deletados para ${userId}.`);
    } catch (err) {
        console.error(`[Sistema] Erro ao deletar arquivos de autenticação para ${userId}:`, err.message);
    }
}

async function getOrCreateWhatsappClient(userId) {
    let sock = whatsappClients[userId];
    
    if (sock && sock.user && sock.ws.readyState === sock.ws.OPEN) {
        return sock;
    }
    
    console.log(`[Sistema] Inicializando cliente Baileys para: ${userId}`);
    
    const { state, saveCreds } = await useMultiFileAuthState(`baileys_auth_${userId}`);

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['SuperApp', 'Chrome', '100.0.0']
    });

    store.bind(sock.ev);
    
    // LÓGICA DE MENSAGENS
    sock.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (message.key.remoteJid === 'status@broadcast') return;

        if (!message.key.fromMe) {
            await handleNewMessage(message, userId);
        } else if (message.key.fromMe) {
            await handleOutgoingMessage(message, userId);
        }
    });

    // LÓGICA DE RECONEXÃO
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            qrcode.toDataURL(qr, (err, url) => {
                qrCodeDataStore[userId] = url; 
                sendEventToUser(userId, { type: 'qr', data: url });
            });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
            
            console.log(`[Baileys - ${userId}] Conexão fechada. Tentando reconectar: ${shouldReconnect}`);
            sendEventToUser(userId, { type: 'status', connected: false, status: 'Fechado/Desconectado' });
            
            if (shouldReconnect) {
                getOrCreateWhatsappClient(userId); 
            } else {
                console.log(`[Baileys - ${userId}] Logout Permanente. Deletando credenciais para novo login.`);
                deleteAuthFiles(userId);
            }
        } else if (connection === 'open') {
            console.log(`[Baileys - ${userId}] Conectado!`);
            delete qrCodeDataStore[userId];
            sendEventToUser(userId, { 
                type: 'status', 
                connected: true, 
                user: sock.user.name || sock.user.id.user 
            });
        }
    });
    
    sock.ev.on('creds.update', saveCreds);

    whatsappClients[userId] = sock;
    return sock;
}


// --- Funções Auxiliares do Bot e IA ---

async function getEstoqueInfo(userData) {
    const estoque = userData.estoque || [];
    if (estoque.length === 0) return "";
    
    let info = "INFORMAÇÃO DE ESTOQUE ATUAL: Use esta lista para responder sobre produtos ou preços. NÃO REVELE CUSTOS.";
    
    estoque.forEach(p => {
        const produtoNome = p.produto || 'Item';
        // Confere se o preço de venda é um número antes de usar toFixed(2)
        const preco = (typeof p.venda === 'number' && !isNaN(p.venda)) ? `R$${p.venda.toFixed(2)}` : 'Preço N/A';
        
        // Apenas Produto e Venda são expostos.
        info += `[Produto: ${produtoNome} | Preço de Venda ao Cliente: ${preco}]; `;
    });
    
    return info + " Nunca mencione o valor de compra ou custos internos.";
}


async function handleNewMessage(message, userId) {
    const userContact = message.key.remoteJid;
    const messageText = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
    
    if (!messageText || userContact === 'status@broadcast') return;

    try {
        const userDocRef = db.collection('userData').doc(userId);
        const userDoc = await userDocRef.get();
        if (!userDoc.exists) return;
        
        let userData = userDoc.data();
        let leads = userData.leads || [];
        const normalizedContact = userContact.split('@')[0];
        let currentLead = leads.find(lead => (lead.whatsapp || '').includes(normalizedContact));
        let isNewLead = false;

        // === 1. CRIAÇÃO DE NOVO LEAD ===
        if (!currentLead) {
            isNewLead = true;
            console.log(`[CRM - ${userId}] Novo contato!`);
            
            const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo.";
            const promptTemplate = `${botInstructions}\n\nAnalise a mensagem: "${messageText}". Extraia o nome do remetente. Responda APENAS com o nome. Se não achar, responda "Novo Contato".`;
            const leadName = (await (await model.generateContent(promptTemplate)).response).text().trim();
            
            const nextId = leads.length > 0 ? Math.max(...leads.map(l => l.id || 0)) + 1 : 1;
            currentLead = { id: nextId, nome: leadName, whatsapp: userContact, status: 'novo', botActive: true, unreadCount: 0 }; 
            
            leads.push(currentLead);
        }
        
        // --- 2. LÓGICA DE SALVAMENTO E NOTIFICAÇÃO (SEMPRE ACONTECE) ---
        const chatRef = db.collection('userData').doc(userId).collection('leads').doc(String(currentLead.id)).collection('chatHistory');
        
        // SALVA A MENSAGEM RECEBIDA DO CLIENTE (role: 'user')
        await chatRef.add({
            role: "user",
            parts: [{text: messageText}],
            timestamp: FieldValue.serverTimestamp(),
        });
        
        const leadIndex = leads.findIndex(l => l.id === currentLead.id);
        if (leadIndex !== -1) {
             leads[leadIndex].unreadCount = (leads[leadIndex].unreadCount || 0) + 1;
        }

        await userDocRef.update({ leads: leads });
        
        sendEventToUser(userId, { type: 'message', from: userContact });

        // --- 3. LÓGICA CONDICIONAL DE RESPOSTA DA IA ---
        if (currentLead.botActive === true) {
            
            console.log(`[Bot - ${userId}] Bot ativo. Gerando resposta para ${currentLead.nome}.`);
            
            // BUSCA E FORMATA O ESTOQUE
            const estoqueInfo = await getEstoqueInfo(userData);
            
            // CRIA O PROMPT COMPLETO
            const botInstructions = userData.botInstructions || "Você é um assistente virtual prestativo.";
            const fullPrompt = `${botInstructions}\n\n${estoqueInfo}\n\nMensagem do cliente: "${messageText}"`;
            
            const aiResponse = (await (await model.generateContent(fullPrompt)).response).text();
            
            // SALVA A RESPOSTA DA IA (role: 'model')
            await chatRef.add({
                role: "model",
                parts: [{text: aiResponse}],
                timestamp: FieldValue.serverTimestamp(),
            });

            // Envia a resposta pelo WhatsApp 
            await whatsappClients[userId].sendMessage(message.key.remoteJid, { text: aiResponse });

        } else {
            console.log(`[Bot - ${userId}] Bot desativado para ${currentLead.nome}. Apenas salvando no histórico.`);
        }

    } catch (error) {
        console.error(`[Baileys - ${userId}] Erro ao processar mensagem (handleNewMessage):`, error);
    }
}


async function handleOutgoingMessage(message, userId) {
    const userContact = message.key.remoteJid;
    const messageText = message.message?.conversation || message.message?.extendedTextMessage?.text || '';
    
    if (!messageText || userContact === 'status@broadcast') return;

    try {
        const userDocRef = db.collection('userData').doc(userId);
        const userDoc = await userDocRef.get();
        if (!userDoc.exists) return;

        let userData = userDoc.data();
        let leads = userData.leads || [];
        const normalizedContact = userContact.split('@')[0];
        let currentLead = leads.find(lead => (lead.whatsapp || '').includes(normalizedContact));

        if (!currentLead) return; 

        // Só salve se o bot estiver INATIVO (ou seja, se a mensagem foi enviada pelo celular)
        if (currentLead.botActive === false) {
            
            console.log(`[Sistema - ${userId}] Salvando mensagem manual (do celular) para ${currentLead.nome}`);
            
            const chatRef = db.collection('userData').doc(userId).collection('leads').doc(String(currentLead.id)).collection('chatHistory');
            
            // SALVA A MENSAGEM (role: 'model' para o lado do negócio/atendente)
            await chatRef.add({
                role: "model",
                parts: [{text: messageText}],
                timestamp: FieldValue.serverTimestamp(),
            });

            // Limpa o contador de não lidas quando você responde
            const leadIndex = leads.findIndex(l => l.id === currentLead.id);
            if (leadIndex !== -1 && (leads[leadIndex].unreadCount || 0) > 0) {
                leads[leadIndex].unreadCount = 0;
                await userDocRef.update({ leads: leads });
                sendEventToUser(userId, { type: 'message', from: userContact });
            }
        }
        
    } catch (error) {
        console.error(`[Sistema - ${userId}] Erro ao processar mensagem enviada (handleOutgoingMessage):`, error);
    }
}


// --- Endpoints para o Frontend (Super App) ---

app.get('/status', async (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ connected: false, error: 'userId é obrigatório' });
    
    const sock = await getOrCreateWhatsappClient(userId);
    const isConnected = (sock.user && sock.ws.readyState === sock.ws.OPEN);

    if (!isConnected && qrCodeDataStore[userId]) {
        return res.status(200).json({ 
            connected: false, 
            status: 'QR_AVAILABLE', 
            qrCodeUrl: qrCodeDataStore[userId] 
        });
    }
    
    return res.status(200).json({ 
        connected: isConnected, 
        user: isConnected ? sock.user.name : 'Dispositivo',
        status: isConnected ? 'CONNECTED' : 'CLOSED'
    });
});

// ENDPOINT /send ATUALIZADO
app.post('/send', async (req, res) => {
    // AGORA EXIGE 'leadId' DO FRONTEND
    const { to, text, userId, leadId } = req.body;
    if (!to || !text || !userId || !leadId) { 
        return res.status(400).json({ ok: false, error: 'Campos to, text, userId e leadId são obrigatórios' });
    }
    
    const sock = whatsappClients[userId];
    if (!sock || !sock.user || sock.ws.readyState !== sock.ws.OPEN) { 
        return res.status(503).json({ ok: false, error: 'Connection Closed.', details: 'O cliente WhatsApp não está autenticado ou está desconectado.' });
    }

    try {
        // --- ETAPA DE SALVAR ---
        const chatRef = db.collection('userData').doc(userId).collection('leads').doc(String(leadId)).collection('chatHistory');
        await chatRef.add({
            role: "model", // "model" é usado para o lado do "negócio/atendente"
            parts: [{text: text}],
            timestamp: FieldValue.serverTimestamp(),
        });

        // 2. Limpa o contador de não lidas (Boa prática)
        const userDocRef = db.collection('userData').doc(userId);
        const userDoc = await userDocRef.get();
        if (userDoc.exists) {
            let leads = userDoc.data().leads || [];
            const leadIndex = leads.findIndex(l => l.id === Number(leadId));
            if (leadIndex !== -1) {
                leads[leadIndex].unreadCount = 0; // Zera o contador
                await userDocRef.update({ leads: leads });
                // Notifica o front para atualizar a lista (remover a bolinha)
                sendEventToUser(userId, { type: 'message', from: to }); 
            }
        }
        // --- FIM DA ETAPA DE SALVAR ---

        // ETAPA DE ENVIAR (JÁ EXISTIA)
        const normalizedTo = to.includes('@s.whatsapp.net') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        await sock.sendMessage(normalizedTo, { text: text });
        
        return res.status(200).json({ ok: true, message: 'Mensagem enviada e salva com sucesso!' });
        
    } catch (error) {
        console.error(`Erro ao enviar/salvar mensagem para ${to}:`, error);
        return res.status(500).json({ ok: false, error: `Falha no envio/salvamento da mensagem: ${error.message}` });
    }
});


app.get('/events', (req, res) => {
    const userId = req.query.userId;
    if (!userId) return res.status(400).json({ error: 'userId é obrigatório' });
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    frontendConnections[userId] = { res };

    getOrCreateWhatsappClient(userId);

    req.on('close', () => delete frontendConnections[userId]);
});

// Endpoint de boas-vindas
app.get('/', (req, res) => {
    res.status(200).json({ status: "Bot está ativo. Migrado para Baileys." });
});

app.listen(port, () => console.log(`[Servidor] Servidor multi-usuário rodando na porta ${port}.`));
