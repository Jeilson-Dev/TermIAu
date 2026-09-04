//! O `config.toml`: o que o app da bandeja edita e o CLI obedece.

use crate::caminhos;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

/// As 54 vozes do Kokoro v1.0. A primeira letra é o idioma em que a voz foi
/// treinada e a segunda é o gênero — `if_sara` é italiana feminina.
///
/// Qualquer uma delas lê fonemas de português: quem decide a pronúncia são os
/// fonemas, não o timbre. O idioma de origem só deixa um resíduo de sotaque.
pub const CATALOGO: &[&str] = &[
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole",
    "af_nova", "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir",
    "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa", "bf_alice", "bf_emma",
    "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis", "ef_dora",
    "em_alex", "em_santa", "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara",
    "im_nicola", "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo", "pf_dora",
    "pm_alex", "pm_santa", "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian",
    "zm_yunxi", "zm_yunxia", "zm_yunyang",
];

pub fn idioma(id: &str) -> &'static str {
    match id.chars().next() {
        Some('a') => "inglês americano",
        Some('b') => "inglês britânico",
        Some('e') => "espanhol",
        Some('f') => "francês",
        Some('h') => "hindi",
        Some('i') => "italiano",
        Some('j') => "japonês",
        Some('p') => "português",
        Some('z') => "mandarim",
        _ => "desconhecido",
    }
}

pub fn feminina(id: &str) -> bool {
    id.chars().nth(1) == Some('f')
}

/// `if_sara` -> `Sara`.
pub fn nome_da_voz(id: &str) -> String {
    let cru = id.split_once('_').map(|(_, n)| n).unwrap_or(id);
    let mut letras = cru.chars();
    match letras.next() {
        Some(p) => p.to_uppercase().collect::<String>() + letras.as_str(),
        None => id.to_string(),
    }
}

/// Um ponto de partida pronto para a mistura de vozes.
///
/// As três vozes de português do Kokoro v1.0 foram treinadas com pouquíssimo
/// material e carregam um chiado áspero — algo parece vibrar junto com a fala.
/// As de italiano não têm esse defeito. Misturar quase toda a italiana com um
/// quinto da voz de português devolve a cor da fala brasileira sem trazer o
/// chiado junto; foi a receita escolhida de ouvido, comparando proporções.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Receita {
    pub id: &'static str,
    pub nome: &'static str,
    pub descricao: &'static str,
    pub principal: &'static str,
    pub secundaria: Option<&'static str>,
    /// Quanto da segunda voz entra, de 0 a 100.
    pub mistura: u8,
}

pub const RECEITAS: &[Receita] = &[
    Receita {
        id: "dora",
        nome: "Dora",
        descricao: "feminina e macia — a padrão",
        principal: "if_sara",
        secundaria: Some("pf_dora"),
        mistura: 20,
    },
    Receita {
        id: "nicola",
        nome: "Nicola",
        descricao: "masculina e macia",
        principal: "im_nicola",
        secundaria: Some("pm_alex"),
        mistura: 20,
    },
    Receita {
        id: "sara",
        nome: "Sara",
        descricao: "feminina, sem tempero de português",
        principal: "if_sara",
        secundaria: None,
        mistura: 0,
    },
    Receita {
        id: "dora_original",
        nome: "Dora original",
        descricao: "a voz de português do Kokoro, mais áspera",
        principal: "pf_dora",
        secundaria: None,
        mistura: 0,
    },
];

/// Uma voz do rodízio, do jeito que ela aparece no `config.toml`: a mistura
/// inteira, com os números à vista para serem mexidos.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VozDoRodizio {
    /// Como chamar esta voz — no mapa de chamadores e no `--voz`.
    pub nome: String,
    /// Voz principal, um nome do [`CATALOGO`].
    pub voz: String,
    /// Voz que tempera a principal, se houver.
    #[serde(default)]
    pub voz_secundaria: Option<String>,
    /// Quanto da segunda entra, de 0 a 100.
    #[serde(default)]
    pub mistura: u8,
}

/// O rodízio de fábrica: a ordem em que as vozes são distribuídas entre quem
/// chama, para duas sessões abertas ao mesmo tempo não soarem iguais.
///
/// Começa pelas receitas, que são as que soam melhor em português, e segue
/// para vozes de outros idiomas — o resíduo de sotaque, que em geral é
/// defeito, aqui é justamente o que faz uma sessão não ser confundida com a
/// outra. A lista mora no `config.toml` e é para ser mexida: trocar uma voz,
/// mudar a proporção da mistura, tirar as que não agradam.
fn rodizio_padrao() -> Vec<VozDoRodizio> {
    let voz = |nome: &str, principal: &str, segunda: Option<&str>, mistura: u8| VozDoRodizio {
        nome: nome.to_string(),
        voz: principal.to_string(),
        voz_secundaria: segunda.map(String::from),
        mistura,
    };
    vec![
        voz("dora", "if_sara", Some("pf_dora"), 20),
        voz("nicola", "im_nicola", Some("pm_alex"), 20),
        voz("sara", "if_sara", None, 0),
        voz("dora_original", "pf_dora", None, 0),
        voz("espanhola", "ef_dora", None, 0),
        voz("espanhol", "em_alex", None, 0),
        voz("inglesa", "bf_emma", None, 0),
        voz("ingles", "am_michael", None, 0),
    ]
}

pub fn receita(id: &str) -> Option<&'static Receita> {
    RECEITAS.iter().find(|r| r.id == id)
}

/// A versão que o config em disco tem quando o campo não existe: são os
/// arquivos escritos antes de a mistura de vozes existir.
fn versao_anterior() -> u32 {
    1
}

pub const VERSAO_ATUAL: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Formato do arquivo, para migrar o que foi gravado por versões antigas.
    #[serde(default = "versao_anterior")]
    pub versao: u32,
    /// Voz principal, um nome do [`CATALOGO`].
    pub voz: String,
    /// Voz temperando a principal, se houver.
    pub voz_secundaria: Option<String>,
    /// Quanto da voz secundária entra, de 0 a 100.
    pub mistura: u8,
    /// 0.5 (bem devagar) a 2.0 (bem rápido).
    pub velocidade: f32,
    /// 0 a 100.
    pub volume: u8,
    /// Guardar o áudio já sintetizado para repetir sem recalcular.
    pub cache: bool,
    /// Corta o texto acima de N caracteres (0 = sem teto).
    pub max_caracteres: usize,
    /// Ninguém fala. É um interruptor só, e é de todo mundo: enquanto ele
    /// estiver ligado, todo `fala_claudio` desta máquina volta calado, venha
    /// de que sessão vier. Desligá-lo devolve a voz a todos de uma vez.
    ///
    /// Mora no `config.toml` porque é lá que mora o que vale para a máquina
    /// inteira — e porque assim ele sobrevive a fechar o app.
    pub mudo: bool,
    /// Falar pela voz do macOS quando o Kokoro não estiver pronto.
    pub reserva_macos: bool,
    /// Voz do `say` usada nessa reserva.
    pub voz_reserva: String,
    /// As vozes que o rodízio distribui entre os chamadores, na ordem em que
    /// serão dadas. É esta lista que se mexe para escolher como cada sessão
    /// vai soar; os nomes daqui também valem no `--voz`.
    pub rodizio: Vec<VozDoRodizio>,
    /// A voz de cada chamador, preenchida sozinha na primeira fala de cada um
    /// e livre para ser trocada à mão — o que estiver escrito aqui manda.
    ///
    /// A chave é a pasta do projeto; uma segunda aba falando da mesma pasta ao
    /// mesmo tempo ganha uma linha própria, com a aba no fim.
    pub vozes_por_chamador: BTreeMap<String, String>,
    /// As palavras que o espeak-ng lê errado e como elas devem soar.
    ///
    /// A chave é a palavra como ela aparece no texto; o valor é a grafia que
    /// se lê como ela deveria soar (`UX = "iu-ex"`) ou, entre barras, os
    /// fonemas prontos (`Claude = "/klˈod/"`).
    pub pronuncia: BTreeMap<String, String>,
    /// O arquivo em disco foi lido de verdade (ou ainda nem existe).
    ///
    /// Não vai para o disco: existe para o rodízio não gravar o padrão por
    /// cima de um arquivo que o dono escreveu e que só não foi lido por causa
    /// de uma vírgula fora do lugar.
    #[serde(skip)]
    pub intacto: bool,
}

impl Default for Config {
    fn default() -> Self {
        let padrao = RECEITAS[0];
        Self {
            versao: VERSAO_ATUAL,
            voz: padrao.principal.into(),
            voz_secundaria: padrao.secundaria.map(String::from),
            mistura: padrao.mistura,
            velocidade: 1.0,
            volume: 60,
            cache: true,
            max_caracteres: 0,
            mudo: false,
            reserva_macos: true,
            voz_reserva: "Luciana".into(),
            rodizio: rodizio_padrao(),
            vozes_por_chamador: BTreeMap::new(),
            pronuncia: BTreeMap::new(),
            intacto: true,
        }
    }
}

impl Config {
    /// Lê o arquivo. Um config ausente ou corrompido não é motivo para não
    /// falar: cai no padrão e segue.
    pub fn carregar() -> Self {
        let texto = caminhos::arquivo_config()
            .ok()
            .and_then(|p| std::fs::read_to_string(p).ok());

        let lido = texto.as_deref().map(|t| toml::from_str::<Config>(t));
        let mut config = match lido {
            Some(Ok(config)) => config,
            // Arquivo ilegível: dá para falar com o padrão, mas não dá para
            // gravar por cima do que o dono escreveu.
            Some(Err(_)) => Config { intacto: false, ..Config::default() },
            None => Config::default(),
        };
        config.normalizar();
        config
    }

    pub fn salvar(&self) -> Result<()> {
        let caminho = caminhos::arquivo_config()?;
        std::fs::write(caminho, toml::to_string_pretty(self)?)?;
        Ok(())
    }

    /// Aplica uma receita pronta por cima da configuração atual.
    pub fn usar_receita(&mut self, id: &str) -> bool {
        match receita(id) {
            Some(r) => {
                self.voz = r.principal.to_string();
                self.voz_secundaria = r.secundaria.map(String::from);
                self.mistura = r.mistura;
                true
            }
            None => false,
        }
    }

    /// Aplica uma voz pelo nome: uma do rodízio do `config.toml`, uma receita
    /// pronta ou um nome cru do catálogo, nessa ordem.
    pub fn usar_voz(&mut self, nome: &str) -> bool {
        if let Some(v) = self.rodizio.iter().find(|v| v.nome == nome).cloned() {
            self.voz = v.voz;
            self.voz_secundaria = v.voz_secundaria;
            self.mistura = v.mistura.min(100);
            return true;
        }
        if self.usar_receita(nome) {
            return true;
        }
        if CATALOGO.contains(&nome) {
            self.voz = nome.to_string();
            self.voz_secundaria = None;
            self.mistura = 0;
            return true;
        }
        false
    }

    /// Existe alguma voz com este nome?
    pub fn conhece_voz(&self, nome: &str) -> bool {
        self.rodizio.iter().any(|v| v.nome == nome)
            || receita(nome).is_some()
            || CATALOGO.contains(&nome)
    }

    /// A voz de um chamador, escolhendo uma do rodízio se ele ainda não tiver.
    ///
    /// Devolve também se o mapa mudou, porque uma atribuição nova precisa ser
    /// gravada para o mesmo projeto soar igual amanhã. Devolve `None` quando
    /// não há rodízio utilizável — aí a voz é a de sempre.
    pub fn voz_do_chamador(&mut self, chave: &str) -> Option<(String, bool)> {
        if let Some(voz) = self.vozes_por_chamador.get(chave) {
            return Some((voz.clone(), false));
        }
        if !self.intacto {
            return None;
        }

        // Uma entrada que aponta para voz inexistente é pulada, não apagada:
        // um erro de digitação na lista não some do arquivo sem o dono ver.
        let disponiveis: Vec<&str> = self
            .rodizio
            .iter()
            .filter(|v| CATALOGO.contains(&v.voz.as_str()))
            .map(|v| v.nome.as_str())
            .collect();
        if disponiveis.is_empty() {
            return None;
        }

        let usadas: HashSet<&str> =
            self.vozes_por_chamador.values().map(|v| v.as_str()).collect();
        let escolhida = disponiveis
            .iter()
            .find(|nome| !usadas.contains(*nome))
            .copied()
            // Rodízio esgotado: dá a volta e repete, que é melhor que ficar
            // sem voz nenhuma.
            .unwrap_or(disponiveis[self.vozes_por_chamador.len() % disponiveis.len()])
            .to_string();

        self.vozes_por_chamador.insert(chave.to_string(), escolhida.clone());
        Some((escolhida, true))
    }

    /// A receita que a configuração atual reproduz, se for alguma.
    pub fn receita_atual(&self) -> Option<&'static str> {
        RECEITAS
            .iter()
            .find(|r| {
                r.principal == self.voz
                    && r.secundaria.map(String::from) == self.voz_secundaria
                    && (r.secundaria.is_none() || r.mistura == self.mistura)
            })
            .map(|r| r.id)
    }

    /// As vozes e os pesos que vão para o modelo.
    pub fn mistura_efetiva(&self) -> Vec<(String, f32)> {
        match &self.voz_secundaria {
            Some(segunda) if self.mistura > 0 && segunda != &self.voz => {
                let p = self.mistura.min(100) as f32 / 100.0;
                vec![(self.voz.clone(), 1.0 - p), (segunda.clone(), p)]
            }
            _ => vec![(self.voz.clone(), 1.0)],
        }
    }

    /// Um resumo estável da mistura, para servir de chave de cache.
    pub fn assinatura_da_voz(&self) -> String {
        self.mistura_efetiva()
            .iter()
            .map(|(v, p)| format!("{v}:{p:.3}"))
            .collect::<Vec<_>>()
            .join("+")
    }

    /// Um resumo do dicionário de pronúncia, para entrar na chave do cache:
    /// mudar como uma palavra se fala tem que mudar o áudio guardado dela.
    ///
    /// Vale o dicionário inteiro, e não só as palavras deste texto: ressintetizar
    /// o que não mudou custa menos que descobrir o que mudou.
    pub fn assinatura_da_pronuncia(&self) -> String {
        self.pronuncia
            .iter()
            .map(|(palavra, como)| format!("{palavra}={como}"))
            .collect::<Vec<_>>()
            .join("|")
    }

    /// Conserta valores fora da faixa em vez de recusar, e leva quem gravou o
    /// nome de uma receita (ou um config de versão anterior) para a mistura
    /// equivalente.
    pub fn normalizar(&mut self) {
        // Config escrito antes de a mistura existir: quem tinha escolhido uma
        // voz de português passa a ouvir a mistura equivalente, que é o mesmo
        // falante sem o chiado.
        if self.versao < VERSAO_ATUAL {
            let equivalente = match self.voz.as_str() {
                "pm_alex" | "pm_santa" => Some("nicola"),
                "pf_dora" => Some("dora"),
                _ => None,
            };
            if let Some(id) = equivalente {
                self.usar_receita(id);
            }
            self.versao = VERSAO_ATUAL;
        }

        if let Some(r) = receita(&self.voz) {
            let r = *r;
            self.voz = r.principal.to_string();
            self.voz_secundaria = r.secundaria.map(String::from);
            self.mistura = r.mistura;
        }
        if self.voz.is_empty() {
            *self = Config { velocidade: self.velocidade, volume: self.volume, ..Config::default() };
        }
        if self.voz_secundaria.as_deref() == Some("") {
            self.voz_secundaria = None;
        }
        // Linha do dicionário sem palavra ou sem pronúncia não corrige nada;
        // fica só atrapalhando quem lê o arquivo.
        self.pronuncia
            .retain(|palavra, como| !palavra.trim().is_empty() && !como.trim().is_empty());
        self.mistura = self.mistura.min(100);
        self.velocidade = self.velocidade.clamp(0.5, 2.0);
        self.volume = self.volume.min(100);
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn a_receita_padrao_e_a_mistura_escolhida() {
        let c = Config::default();
        assert_eq!(c.receita_atual(), Some("dora"));
        assert_eq!(
            c.mistura_efetiva(),
            vec![("if_sara".to_string(), 0.8), ("pf_dora".to_string(), 0.2)]
        );
    }

    #[test]
    fn sem_segunda_voz_a_mistura_e_so_a_principal() {
        let mut c = Config::default();
        c.usar_receita("sara");
        assert_eq!(c.mistura_efetiva(), vec![("if_sara".to_string(), 1.0)]);
    }

    #[test]
    fn config_antigo_de_voz_aspera_migra_para_a_mistura() {
        let mut c = Config { versao: 1, voz: "pf_dora".into(), ..Config::default() };
        c.normalizar();
        assert_eq!(c.versao, VERSAO_ATUAL);
        assert_eq!(c.receita_atual(), Some("dora"));
    }

    #[test]
    fn o_nome_de_uma_receita_no_campo_voz_vira_a_receita() {
        let mut c = Config { voz: "nicola".into(), ..Config::default() };
        c.normalizar();
        assert_eq!(c.voz, "im_nicola");
        assert_eq!(c.voz_secundaria.as_deref(), Some("pm_alex"));
    }

    #[test]
    fn cada_chamador_novo_ganha_a_proxima_voz_do_rodizio() {
        let mut c = Config::default();
        assert_eq!(c.voz_do_chamador("/a"), Some(("dora".into(), true)));
        assert_eq!(c.voz_do_chamador("/b"), Some(("nicola".into(), true)));
        // O mesmo chamador volta com a mesma voz, e sem regravar nada.
        assert_eq!(c.voz_do_chamador("/a"), Some(("dora".into(), false)));
    }

    #[test]
    fn o_que_esta_escrito_no_mapa_manda_sobre_o_rodizio() {
        let mut c = Config::default();
        c.vozes_por_chamador.insert("/a".into(), "sara".into());
        assert_eq!(c.voz_do_chamador("/a"), Some(("sara".into(), false)));
        // E a voz fixada sai do rodízio para os próximos.
        assert_eq!(c.voz_do_chamador("/b"), Some(("dora".into(), true)));
    }

    #[test]
    fn config_ilegivel_nao_ganha_atribuicao_nova() {
        let mut c = Config { intacto: false, ..Config::default() };
        assert_eq!(c.voz_do_chamador("/a"), None);
        assert!(c.vozes_por_chamador.is_empty());
    }

    #[test]
    fn rodizio_so_com_voz_inexistente_nao_atribui_nada() {
        let mut c = Config {
            rodizio: vec![VozDoRodizio {
                nome: "minha".into(),
                voz: "voz_que_nao_existe".into(),
                voz_secundaria: None,
                mistura: 0,
            }],
            ..Config::default()
        };
        assert_eq!(c.voz_do_chamador("/a"), None);
        assert!(c.vozes_por_chamador.is_empty());
    }

    #[test]
    fn uma_voz_do_rodizio_entra_com_a_mistura_que_esta_escrita() {
        let mut c = Config::default();
        c.rodizio[0].mistura = 30;
        assert!(c.usar_voz("dora"));
        assert_eq!(c.mistura, 30);
        assert_eq!(c.voz, "if_sara");
        assert_eq!(c.voz_secundaria.as_deref(), Some("pf_dora"));
    }

    #[test]
    fn todo_o_rodizio_de_fabrica_aponta_para_voz_que_existe() {
        for v in rodizio_padrao() {
            assert!(CATALOGO.contains(&v.voz.as_str()), "{} não existe", v.voz);
            if let Some(s) = &v.voz_secundaria {
                assert!(CATALOGO.contains(&s.as_str()), "{s} não existe");
            }
        }
    }

    #[test]
    fn linha_vazia_do_dicionario_some_ao_normalizar() {
        let mut c = Config::default();
        c.pronuncia.insert("UX".into(), "iu-ex".into());
        c.pronuncia.insert("SQL".into(), "  ".into());
        c.pronuncia.insert("  ".into(), "nada".into());
        c.normalizar();
        assert_eq!(c.pronuncia.len(), 1);
        assert_eq!(c.pronuncia.get("UX").map(String::as_str), Some("iu-ex"));
    }

    /// O TOML exige que as tabelas venham depois dos valores soltos; um campo
    /// novo no lugar errado grava um arquivo que não volta.
    #[test]
    fn o_config_inteiro_vai_ao_disco_e_volta() {
        let mut c = Config::default();
        c.pronuncia.insert("UX".into(), "iu-ex".into());
        c.pronuncia.insert("Claude".into(), "/klˈod/".into());
        c.vozes_por_chamador.insert("/tmp/api".into(), "nicola".into());

        let texto = toml::to_string_pretty(&c).expect("não serializou");
        let voltou: Config = toml::from_str(&texto).expect("não desserializou");

        assert_eq!(voltou.pronuncia, c.pronuncia);
        assert_eq!(voltou.vozes_por_chamador, c.vozes_por_chamador);
        assert_eq!(voltou.rodizio.len(), c.rodizio.len());
    }

    #[test]
    fn mexer_no_dicionario_muda_a_chave_do_cache() {
        let mut c = Config::default();
        let antes = c.assinatura_da_pronuncia();
        c.pronuncia.insert("UX".into(), "iu-ex".into());
        assert_ne!(c.assinatura_da_pronuncia(), antes);
    }

    #[test]
    fn todas_as_receitas_apontam_para_vozes_do_catalogo() {
        for r in RECEITAS {
            assert!(CATALOGO.contains(&r.principal), "{} não existe", r.principal);
            if let Some(s) = r.secundaria {
                assert!(CATALOGO.contains(&s), "{s} não existe");
            }
        }
    }
}
