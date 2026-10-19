//! The progress of a long task, as Claude publishes it with `termiau progress`.
//!
//! Claude sends the whole plan each time — blocks, each with a status and, if it
//! wants, the items inside it — and the footer shows how much is done. It is checked
//! here, before reaching the webview, because this is the only place that can answer:
//! a malformed plan comes back to Claude as an error on the command's output, and
//! it fixes it, instead of the footer silently showing nothing.

use serde::{Deserialize, Serialize};

/// More than this isn't a plan to follow in a footer anymore.
const MAX_BLOCKS: usize = 40;
const MAX_ITEMS: usize = 40;
const MAX_NAME: usize = 160;

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
struct Block {
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
struct Plan {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    blocks: Vec<Block>,
}

fn check_name(n: &str, place: &str) -> Result<(), String> {
    if n.trim().is_empty() {
        return Err(format!("{place}: empty name"));
    }
    if n.chars().count() > MAX_NAME {
        return Err(format!("{place}: name longer than {MAX_NAME} characters"));
    }
    Ok(())
}

fn validate(v: serde_json::Value) -> Result<Plan, String> {
    let plan: Plan = serde_json::from_value(v).map_err(|e| e.to_string())?;
    if plan.blocks.is_empty() {
        return Err("`blocks` is empty".into());
    }
    if plan.blocks.len() > MAX_BLOCKS {
        return Err(format!("more than {MAX_BLOCKS} blocks"));
    }
    for (i, b) in plan.blocks.iter().enumerate() {
        let place = format!("blocks[{i}]");
        check_name(&b.name, &place)?;
        if let Some(p) = b.percent {
            if !(0.0..=100.0).contains(&p) {
                return Err(format!("{place}: `percent` must be between 0 and 100"));
            }
        }
        if b.weight.is_some_and(|w| !(w > 0.0 && w.is_finite())) {
            return Err(format!("{place}: `weight` must be greater than 0"));
        }
        if b.items.len() > MAX_ITEMS {
            return Err(format!("{place}: more than {MAX_ITEMS} items"));
        }
        for (j, item) in b.items.iter().enumerate() {
            check_name(&item.name, &format!("{place}.items[{j}]"))?;
        }
    }
    Ok(plan)
}

/// What came through the socket, if it is a `termiau progress`: the event for the
/// webview, already checked (`{"panel":N,"progress":plan|null}`), or what is wrong
/// with it. `None` for everything else (the hooks, `termiau view`).
///
/// The plan arrives as text, exactly as Claude wrote it (`progress_text`; lib.rs's `normalize_socket` has already renamed the old keys): parsing
/// it here is what lets a JSON mistake come back with its line and column.
pub fn from_socket(text: &str) -> Option<Result<String, String>> {
    let v: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let plan = v.get("progress_text")?.as_str()?;
    let panel = v.get("panel").and_then(|p| p.as_u64()).unwrap_or(0);
    let plan: serde_json::Value = match serde_json::from_str(plan) {
        Ok(p) => p,
        Err(e) => return Some(Err(format!("invalid JSON: {e}"))),
    };
    // `null` takes the plan off the footer.
    if plan.is_null() {
        return Some(Ok(serde_json::json!({ "panel": panel, "progress": null }).to_string()));
    }
    Some(validate(plan).map(|plan| serde_json::json!({ "panel": panel, "progress": plan }).to_string()))
}

#[cfg(test)]
mod tests {
    use super::from_socket;

    /// The message as the CLI sends it: the plan as a string.
    fn send(plan: &str) -> Option<Result<String, String>> {
        from_socket(&serde_json::json!({ "panel": 3, "progress_text": plan }).to_string())
    }

    #[test]
    fn ignores_what_isnt_progress() {
        assert!(from_socket(r#"{"panel":1,"view":{"path":"/x"}}"#).is_none());
        assert!(from_socket("not json").is_none());
    }

    #[test]
    fn accepts_a_plan_and_returns_it_normalized() {
        let ok = send(
            r#"{"title":"T","blocks":[{"name":"A","status":"done"},
               {"name":"B","status":"doing","percent":30,"items":[{"name":"b1","status":"todo"}]}]}"#,
        )
        .unwrap()
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&ok).unwrap();
        assert_eq!(v["panel"], 3);
        assert_eq!(v["progress"]["blocks"][1]["percent"], 30.0);
        assert!(v["progress"]["blocks"][0].get("items").is_none());
    }

    #[test]
    fn null_clears() {
        assert_eq!(send("null").unwrap().unwrap(), r#"{"panel":3,"progress":null}"#);
    }

    #[test]
    fn explains_the_error() {
        let error = |s: &str| send(s).unwrap().unwrap_err();
        assert!(error("{\n\"blocks\": [,]}").contains("line 2"));
        assert!(error(r#"{"blocks":[]}"#).contains("empty"));
        assert!(error(r#"{"blocks":[{"name":"A","status":"started"}]}"#).contains("unknown variant"));
        assert!(error(r#"{"blocks":[{"name":"A","status":"doing","percent":130}]}"#).contains("percent"));
        assert!(error(r#"{"blocks":[{"name":" ","status":"todo"}]}"#).contains("blocks[0]"));
        assert!(error(r#"{"blocks":[{"nome":"A","status":"todo"}]}"#).contains("unknown field"));
    }
}
