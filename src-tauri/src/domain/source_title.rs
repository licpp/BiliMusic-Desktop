use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonSummary {
    pub id: i64,
    pub uploader_id: i64,
    pub title: String,
    pub cover_url: String,
    pub uploader_name: String,
}

impl SeasonSummary {
    pub fn is_legacy_catalog(&self) -> bool {
        // Older creator and linked-folder queues synthesized these season records.
        (self.uploader_id == 0 && self.uploader_name.is_empty() && self.cover_url.is_empty())
            || (self.id == self.uploader_id && self.title == self.uploader_name)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTitleContext {
    pub video_title: String,
    pub part_title: String,
    pub part_count: usize,
    pub season: Option<SeasonSummary>,
    #[serde(default)]
    pub chapter_context: bool,
}
impl SourceTitleContext {
    pub fn discard_legacy_catalog(&mut self) -> bool {
        if !self
            .season
            .as_ref()
            .is_some_and(SeasonSummary::is_legacy_catalog)
        {
            return false;
        }
        self.season = None;
        self.chapter_context = false;
        true
    }

    pub fn preserve_membership(&mut self, previous: Option<&Self>) {
        self.discard_legacy_catalog();
        if let Some(previous) = previous {
            if self.season.is_none() {
                self.season = previous.season.clone();
            }
            self.chapter_context |= previous.chapter_context;
        }
    }

    pub fn title(&self) -> String {
        source_title(
            &self.video_title,
            &self.part_title,
            self.part_count,
            self.season.is_some() || self.chapter_context,
            self.season.as_ref().map(|s| s.title.as_str()).unwrap_or(""),
        )
    }
}
fn fold(c: char) -> char {
    if ('\u{ff01}'..='\u{ff5e}').contains(&c) {
        char::from_u32(c as u32 - 0xfee0).unwrap_or(c)
    } else {
        c
    }
}
fn identity(value: &str) -> String {
    value
        .chars()
        .map(fold)
        .flat_map(char::to_lowercase)
        .filter(|c| c.is_alphanumeric())
        .collect()
}
fn generic(part: &str) -> bool {
    let normalized = identity(part);
    normalized
        .strip_prefix("part")
        .or_else(|| normalized.strip_prefix('p'))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()))
        || matches!(part.trim(), "正片" | "视频" | "默认" | "默认标题")
}
fn without_series_prefix(title: &str, series: &str) -> String {
    let prefix = identity(series);
    if prefix.chars().count() < 3 {
        return title.trim().to_owned();
    }
    let normalized: String = title.chars().map(fold).collect();
    let mut matched = String::new();
    let mut end = 0;
    for (index, letter) in normalized.char_indices() {
        end = index + letter.len_utf8();
        matched.push_str(&identity(&letter.to_string()));
        if !prefix.starts_with(&matched) {
            return title.trim().to_owned();
        }
        if matched == prefix {
            break;
        }
    }
    let rest = &normalized[end..];
    let suffix = rest
        .trim_start_matches(|c: char| c.is_whitespace() || ":：|丨/·,，—–-]】)）".contains(c))
        .trim();
    let boundary = rest
        .chars()
        .next()
        .is_some_and(|c| !c.is_alphanumeric() || c.is_ascii_digit())
        || ["序言", "前言", "后记", "番外"]
            .iter()
            .any(|p| rest.starts_with(p))
        || rest
            .strip_prefix('第')
            .and_then(|s| s.chars().next())
            .is_some_and(|c| c.is_ascii_digit() || "一二三四五六七八九十百零〇".contains(c));
    if matched == prefix && boundary && !suffix.is_empty() && !generic(suffix) {
        suffix.to_owned()
    } else {
        title.trim().to_owned()
    }
}
/// Original BV titles and user choices stay separate from this derived name.
pub fn source_title(video: &str, part: &str, count: usize, chapter: bool, series: &str) -> String {
    let part = part.trim();
    let base = if !part.is_empty() && !generic(part) && (count > 1 || chapter) {
        part
    } else {
        video.trim()
    };
    if chapter || count > 1 {
        without_series_prefix(base, series)
    } else {
        base.to_owned()
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn shared_title_contract() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/source-title.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                super::source_title(
                    case["video"].as_str().unwrap(),
                    case["part"].as_str().unwrap(),
                    case["count"].as_u64().unwrap() as usize,
                    case["chapter"].as_bool().unwrap(),
                    case["series"].as_str().unwrap_or("")
                ),
                case["expected"].as_str().unwrap(),
                "{case}"
            );
        }
    }
}
