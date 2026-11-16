//! Native notification/overlay lyrics use the same saved time axis on each platform.
use serde_json::Value;

pub fn timed_lines(raw: &str, parsed: &str) -> Vec<Value> {
    let timed = raw.split('[').skip(1).any(|rest| {
        rest.split_once(':').is_some_and(|(minutes, seconds)| {
            (1..=3).contains(&minutes.len())
                && minutes.bytes().all(|b| b.is_ascii_digit())
                && seconds
                    .as_bytes()
                    .first()
                    .is_some_and(|b| b.is_ascii_digit())
        })
    });
    if !timed {
        return vec![];
    }
    let Ok(mut lines) = serde_json::from_str::<Vec<Value>>(parsed) else {
        return vec![];
    };
    lines.retain(|line| {
        line["timeMs"]
            .as_f64()
            .is_some_and(|t| t.is_finite() && t >= 0.0)
            && line["text"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty())
    });
    lines.sort_by(|a, b| {
        a["timeMs"]
            .as_f64()
            .unwrap()
            .total_cmp(&b["timeMs"].as_f64().unwrap())
    });
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_time_axis_preserves_words_and_filters_invalid_lines() {
        let lines = timed_lines(
            "[00:01]hello",
            r#"[{"timeMs":2000,"text":"next"},{"timeMs":1000,"text":"hello","words":[{"text":"hello","startTimeMs":1000,"endTimeMs":2000}]},{"timeMs":-1,"text":"bad"},{"timeMs":5,"text":""}]"#,
        );
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["words"][0]["text"], "hello");
        assert_eq!(lines[1]["timeMs"], 2000);
        assert!(timed_lines("plain lyrics", r#"[{"timeMs":0,"text":"plain"}]"#).is_empty());
        assert!(timed_lines("[00:01]hello", "invalid json").is_empty());
    }
}
