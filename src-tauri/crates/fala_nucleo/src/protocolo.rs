//! A conversa entre o CLI e o app da bandeja.
//!
//! Uma linha de JSON por mensagem, num soquete Unix. O CLI manda o texto e o
//! app — que já tem o modelo na memória — fala. Se o app não estiver rodando,
//! o CLI se vira sozinho: o soquete é um atalho, não uma dependência.

use serde::{Deserialize, Serialize};

/// De onde partiu a fala, para o app saber com que voz respondê-la.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chamador {
    /// A pasta do projeto: a raiz do repositório, ou o diretório atual.
    pub projeto: String,
    /// A aba do terminal, quando dá para saber qual é.
    #[serde(default)]
    pub aba: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "acao", rename_all = "snake_case")]
pub enum Pedido {
    /// Falar um texto. Entra no fim da fila; nada é interrompido. Os campos
    /// em branco usam a configuração salva.
    Falar {
        texto: String,
        /// Só quando foi pedida na linha de comando. Em branco, quem escolhe é
        /// o app, pela pasta de quem chamou.
        #[serde(default)]
        voz: Option<String>,
        #[serde(default)]
        voz_secundaria: Option<String>,
        #[serde(default)]
        mistura: Option<u8>,
        #[serde(default)]
        chamador: Option<Chamador>,
        #[serde(default)]
        velocidade: Option<f32>,
        #[serde(default)]
        volume: Option<u8>,
        /// Só responder quando esta fala terminar — a espera pela vez na fila
        /// inclusive.
        #[serde(default)]
        esperar: bool,
    },
    /// Calar a fala em andamento e esvaziar a fila.
    Parar,
    /// Ligar ou desligar o mudo — o interruptor que cala todas as sessões de
    /// uma vez. Com o app aberto é ele quem grava, para o menu da bandeja e o
    /// arquivo nunca discordarem.
    Mudo { mudo: bool },
    /// Trazer a janela de configurações para a frente.
    Mostrar,
    /// O app está vivo e com o modelo carregado?
    Status,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Resposta {
    pub ok: bool,
    /// Uma frase curta para o humano: o que aconteceu, ou por que não.
    pub detalhe: String,
    /// Preenchido pelo `Status`.
    #[serde(default)]
    pub modelo_carregado: bool,
    /// Quantas falas esperam a vez na frente desta.
    #[serde(default)]
    pub na_fila: usize,
    /// O que está saindo agora e o que espera a vez, em duas frases cada.
    /// Preenchido pelo `Status`.
    #[serde(default)]
    pub falando: Option<String>,
    #[serde(default)]
    pub fila: Vec<String>,
    /// O mudo está ligado? Preenchido pelo `Status`.
    #[serde(default)]
    pub mudo: bool,
}

impl Resposta {
    fn vazia() -> Self {
        Self {
            ok: false,
            detalhe: String::new(),
            modelo_carregado: false,
            na_fila: 0,
            falando: None,
            fila: Vec::new(),
            mudo: false,
        }
    }

    pub fn certo(detalhe: impl Into<String>) -> Self {
        Self { ok: true, detalhe: detalhe.into(), modelo_carregado: true, ..Self::vazia() }
    }

    pub fn erro(detalhe: impl Into<String>) -> Self {
        Self { ok: false, detalhe: detalhe.into(), ..Self::vazia() }
    }
}
