//! Read a bounded DASH SIDX and expose its existing fragments as HLS byte ranges.
//! Media bytes, timestamps and the persistent playback-cache format stay unchanged.
pub const INDEX_LIMIT: usize = 2 * 1024 * 1024;
pub fn prefer_segmented(_duration_seconds: i64, codecs: &str) -> bool {
    // The fragmented container, not the recording length, causes WebKit to scan
    // for duration. Half-hour episodes can exhibit the same bug as long videos.
    let codecs = codecs.to_ascii_lowercase();
    ["mp4a", "avc1", "avc3", "hvc1", "hev1"]
        .iter()
        .any(|prefix| codecs.starts_with(prefix))
}
#[derive(Debug, PartialEq)]
pub struct Segment {
    pub start: u64,
    pub bytes: u64,
    pub ticks: u32,
}
#[derive(Debug, PartialEq)]
pub struct Index {
    pub init_bytes: u64,
    pub timescale: u32,
    pub segments: Vec<Segment>,
}
#[derive(Debug, PartialEq)]
pub enum Probe {
    More,
    Unsupported,
    Ready(Index),
}
fn u32_at(b: &[u8], i: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(i..i + 4)?.try_into().ok()?))
}
fn u64_at(b: &[u8], i: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(i..i + 8)?.try_into().ok()?))
}
pub fn probe(bytes: &[u8], total: u64) -> Probe {
    let mut at = 0usize;
    let mut init = 0u64;
    let mut ftyp = false;
    while at + 8 <= bytes.len() {
        let small = u32_at(bytes, at).unwrap();
        let kind = &bytes[at + 4..at + 8];
        let (size, header) = if small == 1 {
            let Some(n) = u64_at(bytes, at + 8) else {
                return Probe::More;
            };
            (n, 16usize)
        } else {
            (small as u64, 8usize)
        };
        if size < header as u64 || size > total || size > INDEX_LIMIT as u64 {
            return Probe::Unsupported;
        }
        let Some(end) = at.checked_add(size as usize) else {
            return Probe::Unsupported;
        };
        if end > INDEX_LIMIT {
            return Probe::Unsupported;
        }
        if end > bytes.len() {
            return Probe::More;
        }
        if kind == b"ftyp" {
            ftyp = true
        }
        if kind == b"moov" {
            init = end as u64
        }
        if kind == b"mdat" || kind == b"moof" {
            return Probe::Unsupported;
        }
        if kind == b"sidx" {
            if !ftyp || init == 0 {
                return Probe::Unsupported;
            }
            let data = &bytes[at + header..end];
            let Some(scale) = u32_at(data, 8).filter(|n| *n > 0) else {
                return Probe::Unsupported;
            };
            let Some(version) = data.first() else {
                return Probe::Unsupported;
            };
            let (offset, count_at) = match version {
                0 => (u32_at(data, 16).map(u64::from), 22),
                1 => (u64_at(data, 20), 30),
                _ => return Probe::Unsupported,
            };
            let Some(offset) = offset else {
                return Probe::Unsupported;
            };
            let Some(count) = data
                .get(count_at..count_at + 2)
                .map(|v| u16::from_be_bytes([v[0], v[1]]) as usize)
            else {
                return Probe::Unsupported;
            };
            if count == 0 || data.len() != count_at + 2 + count * 12 {
                return Probe::Unsupported;
            }
            let Some(mut cursor) = (end as u64).checked_add(offset) else {
                return Probe::Unsupported;
            };
            let mut segments = Vec::with_capacity(count);
            for i in 0..count {
                let p = count_at + 2 + i * 12;
                let word = u32_at(data, p).unwrap();
                let ticks = u32_at(data, p + 4).unwrap();
                let length = (word & 0x7fffffff) as u64;
                // Hierarchical SIDX and empty/time-less fragments need a different resolver.
                if word & 0x80000000 != 0 || length == 0 || ticks == 0 {
                    return Probe::Unsupported;
                }
                let Some(next) = cursor.checked_add(length).filter(|n| *n <= total) else {
                    return Probe::Unsupported;
                };
                segments.push(Segment {
                    start: cursor,
                    bytes: length,
                    ticks,
                });
                cursor = next;
            }
            return Probe::Ready(Index {
                init_bytes: init,
                timescale: scale,
                segments,
            });
        }
        at = end;
    }
    if bytes.len() >= INDEX_LIMIT {
        Probe::Unsupported
    } else {
        Probe::More
    }
}
impl Index {
    pub fn playlist(&self, uri: &str) -> String {
        let scale = self.timescale as u64;
        let target = self
            .segments
            .iter()
            .map(|s| (s.ticks as u64).div_ceil(scale))
            .max()
            .unwrap_or(1);
        let mut text = format!(
            "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:{target}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-MAP:URI=\"{uri}\",BYTERANGE=\"{}@0\"\n",
            self.init_bytes
        );
        for s in &self.segments {
            text.push_str(&format!(
                "#EXTINF:{:.6},\n#EXT-X-BYTERANGE:{}@{}\n{uri}\n",
                s.ticks as f64 / self.timescale as f64,
                s.bytes,
                s.start
            ));
        }
        text.push_str("#EXT-X-ENDLIST\n");
        text
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn atom(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        [
            (data.len() as u32 + 8).to_be_bytes().as_slice(),
            kind.as_slice(),
            data,
        ]
        .concat()
    }
    fn fixture(version: u8) -> Vec<u8> {
        let mut payload = vec![version, 0, 0, 0];
        payload.extend(2u32.to_be_bytes());
        payload.extend(48000u32.to_be_bytes());
        if version == 0 {
            payload.extend(0u32.to_be_bytes());
            payload.extend(7u32.to_be_bytes())
        } else {
            payload.extend(0u64.to_be_bytes());
            payload.extend(7u64.to_be_bytes())
        }
        payload.extend([0, 0, 0, 2]);
        for (length, ticks) in [(100u32, 240000u32), (40, 24001)] {
            payload.extend(length.to_be_bytes());
            payload.extend(ticks.to_be_bytes());
            payload.extend(0x90000000u32.to_be_bytes())
        }
        [
            atom(b"ftyp", b"iso6"),
            atom(b"moov", b"mvex"),
            atom(b"sidx", &payload),
        ]
        .concat()
    }
    #[test]
    fn sidx_versions_preserve_offsets_times_and_only_fetch_the_small_index() {
        for version in [0, 1] {
            let data = fixture(version);
            for end in 0..data.len() {
                assert_eq!(probe(&data[..end], 1000), Probe::More)
            }
            let Probe::Ready(index) = probe(&data, 1000) else {
                panic!("missing index")
            };
            assert_eq!(index.init_bytes, 24);
            assert_eq!(index.segments[0].start, data.len() as u64 + 7);
            assert_eq!(index.segments[1].start, data.len() as u64 + 107);
            let text = index.playlist("/local/audio");
            assert!(text.contains("#EXT-X-TARGETDURATION:5\n"));
            assert!(text.contains("#EXTINF:0.500021,"));
            assert!(text.ends_with("#EXT-X-ENDLIST\n"));
            assert!(text.contains("BYTERANGE=\"24@0\""));
        }
    }
    #[test]
    fn malformed_indexes_never_emit_unbounded_or_invalid_ranges() {
        let valid = fixture(0);
        assert_eq!(probe(&valid, 30), Probe::Unsupported);
        let mut data = valid.clone();
        let start = 24 + 8;
        data[start + 8..start + 12].fill(0);
        assert_eq!(probe(&data, 1000), Probe::Unsupported);
        let mut data = valid.clone();
        data[start + 24] = 0x80;
        assert_eq!(probe(&data, 1000), Probe::Unsupported);
        let mut data = valid.clone();
        data[start] = 2;
        assert_eq!(probe(&data, 1000), Probe::Unsupported);
        assert_eq!(probe(&atom(b"mdat", &[]), 1000), Probe::Unsupported);
        assert_eq!(
            probe(
                &[
                    0, 0, 0, 1, b'm', b'o', b'o', b'v', 255, 255, 255, 255, 255, 255, 255, 255
                ],
                u64::MAX
            ),
            Probe::Unsupported
        );
    }
    #[test]
    fn fragmented_aac_and_video_are_not_gated_by_duration_and_lossless_stays_unchanged() {
        assert!(prefer_segmented(17325, "mp4a.40.2"));
        assert!(prefer_segmented(3600, "MP4A.40.2"));
        assert!(prefer_segmented(3599, "mp4a.40.2"));
        assert!(prefer_segmented(120, "mp4a.40.2"));
        assert!(prefer_segmented(1880, "avc1.64001f"));
        assert!(prefer_segmented(1783, "hvc1.1.6.L120.90"));
        assert!(!prefer_segmented(17325, "flac"));
        assert!(prefer_segmented(0, "mp4a.40.2"));
    }
}
