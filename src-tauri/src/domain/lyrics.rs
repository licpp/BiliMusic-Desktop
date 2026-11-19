//! Native notification/overlay lyrics use the same saved time axis on each platform.
use serde_json::Value;

pub fn has_lrc_timing(raw: &str) -> bool {
    fn digits(value: &str, max: usize) -> bool {
        (1..=max).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
    }

    raw.split('[').skip(1).any(|rest| {
        let Some((stamp, _)) = rest.split_once(']') else {
            return false;
        };
        let Some((minutes, remainder)) = stamp.split_once(':') else {
            return false;
        };
        let (seconds, fraction) = remainder
            .split_once(['.', ':'])
            .map_or((remainder, None), |(seconds, fraction)| {
                (seconds, Some(fraction))
            });
        digits(minutes, 3)
            && digits(seconds, 2)
            && fraction.is_none_or(|fraction| digits(fraction, 3))
    })
}

pub fn timed_lines(raw: &str, parsed: &str) -> Vec<Value> {
    if !has_lrc_timing(raw) {
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
    fn recognizes_the_timestamp_forms_used_by_the_lyric_view() {
        assert!(has_lrc_timing("[00:01]one"));
        assert!(has_lrc_timing("[0:1.23]two"));
        assert!(has_lrc_timing("[123:45:678]three"));
        assert!(!has_lrc_timing(
            "[ti:title]\n[00:01分]\n[01:23.4567]\n[01:23"
        ));
    }

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
