//! The progress of a long task, as Claude publishes it with `termiau progresso`.
//!
//! Claude sends the whole plan each time — blocks, each with a status and, if it
//! wants, the items inside it — and the footer shows how much is done. It is checked
//! here, before reaching the webview, because this is the only place that can answer:
//! a malformed plan comes back to Claude as an error on the command's output, and
//! it fixes it, instead of the footer silently showing nothing.

use serde::{Deserialize, Serialize};

/// More than this isn't a plan to follow in a footer anymore.
const BLOCOS_MAX: usize = 40;
const ITENS_MAX: usize = 40;
const NOME_MAX: usize = 160;

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
enum Status {
    Done,
    Doing,
    Todo,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Item {
    name: String,
    status: Status,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Bloco {
    name: String,
    status: Status,
    /// Only for a block in progress, and only when Claude has a basis for it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    percent: Option<f64>,
    /// How big the block is next to the others; 1 when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    weight: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    items: Vec<Item>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Plano {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    blocks: Vec<Bloco>,
}

fn nome(n: &str, onde: &str) -> Result<(), String> {
    if n.trim().is_empty() {
        return Err(format!("{onde}: empty name"));
    }
    if n.chars().count() > NOME_MAX {
        return Err(format!("{onde}: name longer than {NOME_MAX} characters"));
    }
    Ok(())
}

fn validar(v: serde_json::Value) -> Result<Plano, String> {
    let plano: Plano = serde_json::from_value(v).map_err(|e| e.to_string())?;
    if plano.blocks.is_empty() {
        return Err("`blocks` is empty".into());
    }
    if plano.blocks.len() > BLOCOS_MAX {
        return Err(format!("more than {BLOCOS_MAX} blocks"));
    }
    for (i, b) in plano.blocks.iter().enumerate() {
        let onde = format!("blocks[{i}]");
        nome(&b.name, &onde)?;
        if let Some(p) = b.percent {
            if !(0.0..=100.0).contains(&p) {
                return Err(format!("{onde}: `percent` must be between 0 and 100"));
            }
        }
        if b.weight.is_some_and(|w| !(w > 0.0 && w.is_finite())) {
            return Err(format!("{onde}: `weight` must be greater than 0"));
        }
        if b.items.len() > ITENS_MAX {
            return Err(format!("{onde}: more than {ITENS_MAX} items"));
        }
        for (j, item) in b.items.iter().enumerate() {
            nome(&item.name, &format!("{onde}.items[{j}]"))?;
        }
    }
    Ok(plano)
}

/// What came through the socket, if it is a `termiau progresso`: the event for the
/// webview, already checked (`{"painel":N,"progresso":plan|null}`), or what is wrong
/// with it. `None` for everything else (the hooks, `termiau ver`).
///
/// The plan arrives as text, exactly as Claude wrote it (`progresso_texto`): parsing
/// it here is what lets a JSON mistake come back with its line and column.
pub fn do_socket(texto: &str) -> Option<Result<String, String>> {
    let v: serde_json::Value = serde_json::from_str(texto.trim()).ok()?;
    let plano = v.get("progresso_texto")?.as_str()?;
    let painel = v.get("painel").and_then(|p| p.as_u64()).unwrap_or(0);
    let plano: serde_json::Value = match serde_json::from_str(plano) {
        Ok(p) => p,
        Err(e) => return Some(Err(format!("invalid JSON: {e}"))),
    };
    // `null` takes the plan off the footer.
    if plano.is_null() {
        return Some(Ok(serde_json::json!({ "painel": painel, "progresso": null }).to_string()));
    }
    Some(validar(plano).map(|plano| serde_json::json!({ "painel": painel, "progresso": plano }).to_string()))
}

#[cfg(test)]
mod tests {
    use super::do_socket;

    /// The message as the CLI sends it: the plan as a string.
    fn enviar(plano: &str) -> Option<Result<String, String>> {
        do_socket(&serde_json::json!({ "painel": 3, "progresso_texto": plano }).to_string())
    }

    #[test]
    fn ignora_o_que_nao_e_progresso() {
        assert!(do_socket(r#"{"painel":1,"ver":{"caminho":"/x"}}"#).is_none());
        assert!(do_socket("not json").is_none());
    }

    #[test]
    fn aceita_um_plano_e_devolve_normalizado() {
        let ok = enviar(
            r#"{"title":"T","blocks":[{"name":"A","status":"done"},
               {"name":"B","status":"doing","percent":30,"items":[{"name":"b1","status":"todo"}]}]}"#,
        )
        .unwrap()
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&ok).unwrap();
        assert_eq!(v["painel"], 3);
        assert_eq!(v["progresso"]["blocks"][1]["percent"], 30.0);
        assert!(v["progresso"]["blocks"][0].get("items").is_none());
    }

    #[test]
    fn null_limpa() {
        assert_eq!(enviar("null").unwrap().unwrap(), r#"{"painel":3,"progresso":null}"#);
    }

    #[test]
    fn explica_o_erro() {
        let erro = |s: &str| enviar(s).unwrap().unwrap_err();
        assert!(erro("{\n\"blocks\": [,]}").contains("line 2"));
        assert!(erro(r#"{"blocks":[]}"#).contains("empty"));
        assert!(erro(r#"{"blocks":[{"name":"A","status":"started"}]}"#).contains("unknown variant"));
        assert!(erro(r#"{"blocks":[{"name":"A","status":"doing","percent":130}]}"#).contains("percent"));
        assert!(erro(r#"{"blocks":[{"name":" ","status":"todo"}]}"#).contains("blocks[0]"));
        assert!(erro(r#"{"blocks":[{"nome":"A","status":"todo"}]}"#).contains("unknown field"));
    }
}
