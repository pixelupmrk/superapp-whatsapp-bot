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
