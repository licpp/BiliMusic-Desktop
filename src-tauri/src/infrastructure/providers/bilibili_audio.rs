use super::*;

pub(super) fn audio_streams(dash: &DashData) -> Vec<&DashStream> {
    dash.audio
        .iter()
        .chain(dash.flac.as_ref().and_then(|flac| flac.audio.as_ref()))
        .filter(|stream| {
            let codec = stream.codecs.to_ascii_lowercase();
            (codec.starts_with("mp4a") || codec == "flac")
                && (!stream.base_url.is_empty() || !stream.base_url_camel.is_empty())
        })
        .collect()
}
fn lossless(stream: &DashStream) -> bool {
    stream.codecs.eq_ignore_ascii_case("flac")
}
fn rank(stream: &DashStream) -> (bool, u64) {
    (lossless(stream), stream.bandwidth)
}
pub(super) fn select_audio(dash: &DashData, requested: u32) -> Option<&DashStream> {
    let streams = audio_streams(dash);
    // Lossless is opt-in: automatic playback uses the best available AAC.
    // An unavailable explicit choice also falls back to AAC, never to Hi-Res.
    streams
        .iter()
        .copied()
        .filter(|stream| requested != 0 && stream.id == requested)
        .max_by_key(|stream| rank(stream))
        .or_else(|| {
            streams
                .iter()
                .copied()
                .filter(|stream| !lossless(stream) && stream.id != 30251)
                .max_by_key(|stream| rank(stream))
        })
}
pub(super) fn audio_options(dash: &DashData) -> Vec<QualityOption> {
    let mut streams = audio_streams(dash);
    streams.sort_by_key(|stream| std::cmp::Reverse(rank(stream)));
    let mut seen = std::collections::HashSet::new();
    streams
        .into_iter()
        .filter(|stream| seen.insert(stream.id))
        .map(|stream| {
            let name = if lossless(stream) {
                "Hi-Res 无损 · FLAC"
            } else {
                match stream.id {
                    30280 => "高品质 · AAC",
                    30232 => "标准 · AAC",
                    30216 => "流畅 · AAC",
                    _ => "AAC",
                }
            };
            QualityOption {
                id: stream.id,
                label: if stream.bandwidth > 0 {
                    format!("{name} · 约 {} kbps", (stream.bandwidth + 500) / 1000)
                } else {
                    name.into()
                },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn hires_is_a_separate_track_and_ids_are_not_quality_ranks() {
        let dash: DashData = serde_json::from_value(json!({"audio":[
            {"id":30216,"codecs":"mp4a.40.2","bandwidth":64000,"base_url":"https://cdn/64"},
            {"id":30280,"codecs":"mp4a.40.2","bandwidth":191887,"baseUrl":"https://cdn/192"},
            {"id":30232,"codecs":"mp4a.40.2","bandwidth":131752,"base_url":"https://cdn/132"}],
            "flac":{"display":true,"audio":{"id":30251,"codecs":"fLaC","mime_type":"audio/mp4","bandwidth":1500234,"base_url":"https://cdn/hires"}}
        })).unwrap();
        assert_eq!(select_audio(&dash, 0).unwrap().id, 30280);
        assert_eq!(select_audio(&dash, 999).unwrap().id, 30280);
        for id in [30216, 30232, 30280, 30251] {
            assert_eq!(select_audio(&dash, id).unwrap().id, id);
        }
        let options = audio_options(&dash);
        assert_eq!(
            options.iter().map(|s| s.id).collect::<Vec<_>>(),
            vec![30251, 30280, 30232, 30216]
        );
        assert!(options[0].label.contains("1500 kbps"));
        assert!(options[1].label.contains("192 kbps"));
        assert!(options[2].label.contains("132 kbps"));
    }
    #[test]
    fn lossless_requires_an_explicit_selection_even_without_aac() {
        let dash: DashData = serde_json::from_value(json!({"flac":{"audio":{"id":30251,"codecs":"fLaC","base_url":"https://cdn/hires"}}})).unwrap();
        assert!(select_audio(&dash, 0).is_none());
        assert!(select_audio(&dash, 30280).is_none());
        assert_eq!(select_audio(&dash, 30251).unwrap().id, 30251);
    }
    #[test]
    fn absent_entitlement_or_unusable_tracks_fall_back_to_available_aac() {
        for flac in [
            serde_json::Value::Null,
            json!({"display":true,"audio":null}),
            json!({"audio":{"id":30251,"codecs":"fLaC","base_url":""}}),
        ] {
            let dash:DashData=serde_json::from_value(json!({"audio":[{"id":30280,"codecs":"mp4a.40.2","bandwidth":192000,"base_url":"https://cdn/aac"},{"id":30250,"codecs":"ec-3","bandwidth":500000,"base_url":"https://cdn/dolby"}],"flac":flac})).unwrap();
            assert_eq!(select_audio(&dash, 0).unwrap().id, 30280);
            assert_eq!(select_audio(&dash, 30251).unwrap().id, 30280);
            assert_eq!(audio_options(&dash).len(), 1);
        }
    }
}
