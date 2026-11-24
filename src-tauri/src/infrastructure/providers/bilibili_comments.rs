use super::{BilibiliProvider, ProviderError, normalize_url};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentPage {
    pub items: Vec<CommentItem>,
    pub next: i64,
    pub is_end: bool,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentItem {
    pub id: i64,
    pub root_id: i64,
    pub id_text: String,
    pub root_id_text: String,
    pub parent_id: i64,
    pub user_id: i64,
    pub user_name: String,
    pub avatar_url: String,
    pub message: String,
    pub emotes: std::collections::HashMap<String, String>,
    pub created_at: i64,
    pub like_count: i64,
    pub liked: bool,
    pub reply_count: i64,
    pub replies: Vec<CommentItem>,
}

#[derive(Deserialize, Default)]
struct ReplyData {
    #[serde(default)]
    replies: Option<Vec<RawReply>>,
    #[serde(default)]
    top_replies: Option<Vec<RawReply>>,
    #[serde(default)]
    upper: Option<ReplyUpper>,
    #[serde(default)]
    page: ReplyPageMeta,
}

#[derive(Deserialize)]
struct ReplyUpper {
    top: Option<RawReply>,
}

#[derive(Deserialize, Default)]
struct ReplyPageMeta {
    #[serde(default)]
    acount: i64,
    #[serde(default)]
    num: i64,
    #[serde(default)]
    size: i64,
    #[serde(default)]
    count: i64,
}

#[derive(Deserialize)]
struct RawReply {
    rpid: i64,
    #[serde(default)]
    root: i64,
    #[serde(default)]
    parent: i64,
    #[serde(default, rename = "like")]
    like_count: i64,
    #[serde(default)]
    action: i64,
    #[serde(default)]
    ctime: i64,
    #[serde(default)]
    rcount: i64,
    member: ReplyMember,
    content: ReplyContent,
    #[serde(default)]
    replies: Option<Vec<RawReply>>,
}

#[derive(Deserialize)]
struct ReplyMember {
    #[serde(default)]
    mid: String,
    #[serde(default)]
    uname: String,
    #[serde(default)]
    avatar: String,
}
#[derive(Deserialize)]
struct ReplyContent {
    #[serde(default)]
    message: String,
    emote: Option<std::collections::HashMap<String, ReplyEmote>>,
}

#[derive(Deserialize)]
struct ReplyEmote {
    #[serde(default)]
    url: String,
}

impl BilibiliProvider {
    pub async fn comments(&self, aid: i64, next: i64) -> Result<CommentPage, ProviderError> {
        let page_number = next.max(1);
        let mut url = self.api_url("/x/v2/reply");
        url.query_pairs_mut()
            .append_pair("type", "1")
            .append_pair("oid", &aid.to_string())
            .append_pair("pn", &page_number.to_string())
            .append_pair("sort", "2");
        let data: ReplyData = self.get_data(url).await?;
        Ok(comment_page_from_data(data, page_number))
    }

    pub async fn comment_replies(
        &self,
        aid: i64,
        root: i64,
        page: u32,
    ) -> Result<Vec<CommentItem>, ProviderError> {
        Ok(self.comment_reply_page(aid, root, page).await?.items)
    }

    pub async fn comment_reply_page(
        &self,
        aid: i64,
        root: i64,
        page: u32,
    ) -> Result<CommentPage, ProviderError> {
        let mut url = self.api_url("/x/v2/reply/reply");
        let requested = page.max(1);
        url.query_pairs_mut()
            .append_pair("type", "1")
            .append_pair("oid", &aid.to_string())
            .append_pair("root", &root.to_string())
            .append_pair("pn", &requested.to_string())
            .append_pair("ps", "20");
        let data: ReplyData = self.get_data(url).await?;
        Ok(comment_reply_page_from_data(data, i64::from(requested)))
    }

    pub async fn comment_like(
        &self,
        aid: i64,
        reply_id: i64,
        liked: bool,
    ) -> Result<(), ProviderError> {
        let csrf = self.csrf_token().await?;
        let url = self.api_url("/x/v2/reply/action");
        let form = [
            ("type", "1".to_string()),
            ("oid", aid.to_string()),
            ("rpid", reply_id.to_string()),
            ("action", if liked { "1" } else { "0" }.to_string()),
            ("csrf", csrf),
        ];
        let _: serde_json::Value = self.post_data(url, &form).await?;
        Ok(())
    }

    pub async fn comment_emotes(&self) -> Result<serde_json::Value, ProviderError> {
        let mut url = self.api_url("/x/emote/user/panel/web");
        url.query_pairs_mut().append_pair("business", "reply");
        let mut defaults = self.api_url("/x/emote/package");
        defaults
            .query_pairs_mut()
            .append_pair("business", "reply")
            .append_pair("ids", "1,2");
        let (personal, standard) = tokio::join!(
            self.get_data::<serde_json::Value>(url),
            self.get_data::<serde_json::Value>(defaults)
        );
        let mut packages = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut success = false;
        for data in [standard.as_ref(), personal.as_ref()].into_iter().flatten() {
            success = true;
            for pack in data["packages"].as_array().into_iter().flatten() {
                if pack["emote"]
                    .as_array()
                    .is_some_and(|items| !items.is_empty())
                    && seen.insert(pack["id"].clone())
                {
                    packages.push(pack.clone());
                }
            }
        }
        if !success {
            return Err(personal.err().or_else(|| standard.err()).unwrap());
        }
        Ok(serde_json::json!({"packages": packages}))
    }

    pub async fn comment_reply(
        &self,
        aid: i64,
        message: &str,
        root: Option<i64>,
        parent: Option<i64>,
    ) -> Result<(), ProviderError> {
        let csrf = self.csrf_token().await?;
        let url = self.api_url("/x/v2/reply/add");
        let mut form = vec![
            ("type", "1".to_string()),
            ("oid", aid.to_string()),
            ("message", message.to_string()),
            ("plat", "1".to_string()),
            ("csrf", csrf),
        ];
        if let Some(root) = root {
            form.push(("root", root.to_string()));
        }
        if let Some(parent) = parent {
            form.push(("parent", parent.to_string()));
        }
        let _: serde_json::Value = self.post_data(url, &form).await?;
        Ok(())
    }
}

fn comment_from_raw(raw: RawReply) -> CommentItem {
    let id = raw.rpid;
    let root_id = if raw.root == 0 { id } else { raw.root };
    CommentItem {
        id,
        root_id,
        id_text: id.to_string(),
        root_id_text: root_id.to_string(),
        parent_id: raw.parent,
        user_id: raw.member.mid.parse().unwrap_or(0),
        user_name: raw.member.uname,
        avatar_url: normalize_url(&raw.member.avatar),
        message: raw.content.message,
        emotes: raw
            .content
            .emote
            .unwrap_or_default()
            .into_iter()
            .take(64)
            .filter_map(|(token, emote)| {
                let url = Url::parse(&normalize_url(&emote.url)).ok()?;
                let host = url.host_str()?;
                (url.scheme() == "https"
                    && url.username().is_empty()
                    && url.password().is_none()
                    && ["hdslb.com", "biliimg.com"].iter().any(|domain| {
                        host == *domain
                            || host
                                .strip_suffix(*domain)
                                .is_some_and(|prefix| prefix.ends_with('.'))
                    }))
                .then(|| (token, url.to_string()))
            })
            .collect(),
        created_at: raw.ctime,
        like_count: raw.like_count,
        liked: raw.action == 1,
        reply_count: raw.rcount,
        replies: raw
            .replies
            .unwrap_or_default()
            .into_iter()
            .map(comment_from_raw)
            .collect(),
    }
}

fn comment_page_from_data(data: ReplyData, requested: i64) -> CommentPage {
    let page_size = data.page.size.max(20);
    let page = data.page.num.max(requested);
    // The pinned list is separate from replies. Some responses repeat its first
    // item in upper.top, which also supplies the pin on its own on older responses.
    let first_page = page == 1;
    let pinned = if first_page {
        data.top_replies.unwrap_or_default()
    } else {
        Vec::new()
    };
    let upper_top = if first_page {
        data.upper.and_then(|upper| upper.top)
    } else {
        None
    };
    let mut seen = HashSet::new();
    let items = pinned
        .into_iter()
        .chain(upper_top)
        .chain(data.replies.unwrap_or_default())
        .filter(|reply| seen.insert(reply.rpid))
        .map(comment_from_raw)
        .collect();
    CommentPage {
        items,
        next: page.saturating_add(1),
        is_end: page.saturating_mul(page_size) >= data.page.count,
        total: data.page.count.max(data.page.acount),
    }
}

fn comment_reply_page_from_data(data: ReplyData, requested: i64) -> CommentPage {
    let items: Vec<_> = data
        .replies
        .unwrap_or_default()
        .into_iter()
        .map(comment_from_raw)
        .collect();
    let page = data.page.num.max(requested);
    let total = data.page.count.max(0);
    let is_end = if data.page.size > 0 && (total > 0 || items.is_empty()) {
        total <= page.saturating_mul(data.page.size)
    } else {
        items.len() < 20
    };
    CommentPage {
        items,
        next: page.saturating_add(1),
        is_end,
        total,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn comment_page_includes_pinned_replies_once_and_keeps_server_pagination() {
        use super::{ReplyData, comment_page_from_data};
        use serde_json::{from_value, json};

        let pinned = json!({"rpid": 306410445761_i64, "member": {}, "rcount": 2,
                            "content": {"message": "1.可爱女人00:01  2.半岛铁盒01:03"}});
        let ordinary = json!({"rpid": 272545741232_i64, "member": {}, "content": {}});
        let data = json!({
            "page": {"num": 1, "size": 20, "count": 274, "acount": 274},
            "upper": {"top": pinned},
            "top_replies": [pinned],
            "replies": [ordinary, pinned]
        });
        let first = comment_page_from_data(from_value::<ReplyData>(data.clone()).unwrap(), 1);
        assert_eq!(first.items.len(), 2);
        assert_eq!(first.items[0].id_text, "306410445761");
        assert_eq!(first.items[0].root_id_text, "306410445761");
        assert_eq!(first.items[0].reply_count, 2);
        assert_eq!(first.items[1].id_text, "272545741232");
        assert_eq!(first.next, 2);
        assert!(!first.is_end);
        assert_eq!(first.total, 274);

        let mut later = data;
        later["replies"] = json!([ordinary]);
        let second = comment_page_from_data(from_value::<ReplyData>(later).unwrap(), 2);
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].id_text, "272545741232");
        assert_eq!(second.next, 3);
    }

    #[test]
    fn comment_page_uses_upper_pin_when_the_pinned_list_is_missing() {
        use super::{ReplyData, comment_page_from_data};
        use serde_json::{from_value, json};

        let data: ReplyData = from_value(json!({
            "page": {"num": 1, "size": 20, "count": 1},
            "upper": {"top": {"rpid": 31, "member": {}, "content": {"message": "置顶"}}},
            "top_replies": null,
            "replies": null
        }))
        .unwrap();
        let first = comment_page_from_data(data, 1);
        assert_eq!(first.items.len(), 1);
        assert_eq!(first.items[0].id, 31);
        assert!(first.is_end);
    }

    #[test]
    fn comment_reply_pages_keep_exact_ids_and_follow_metadata_after_short_pages() {
        use super::{ReplyData, comment_reply_page_from_data};
        use serde_json::{from_value, json};

        let payload: ReplyData = from_value(json!({
            "page": {"num": 1, "size": 20, "count": 41},
            "replies": [{"rpid": 90071992547409921_i64, "root": 90071992547409920_i64,
                         "member": {}, "content": {"message": "0:59 续篇"}}]
        }))
        .unwrap();
        let first = comment_reply_page_from_data(payload, 1);
        assert!(!first.is_end);
        assert_eq!(first.next, 2);
        assert_eq!(first.items[0].id_text, "90071992547409921");
        assert_eq!(first.items[0].root_id_text, "90071992547409920");

        let payload: ReplyData =
            from_value(json!({"page": {"num": 3, "size": 20, "count": 41}, "replies": []}))
                .unwrap();
        assert!(comment_reply_page_from_data(payload, 3).is_end);
        assert!(comment_reply_page_from_data(ReplyData::default(), 1).is_end);
    }
}
