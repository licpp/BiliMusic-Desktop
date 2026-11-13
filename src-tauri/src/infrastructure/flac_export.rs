//! Lossless ISO BMFF FLAC -> native FLAC. No decoder, encoder or external binary.
//! See xiph/flac doc/isoflac.txt: dfLa holds native metadata; samples are FLAC frames.
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
};
#[derive(Clone, Copy)]
struct Atom<'a> {
    kind: [u8; 4],
    data: &'a [u8],
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "这份无损音源的封装不完整或暂不支持",
    )
}
fn u32_at(bytes: &[u8], at: usize) -> io::Result<u32> {
    Ok(u32::from_be_bytes(
        bytes
            .get(at..at + 4)
            .ok_or_else(invalid)?
            .try_into()
            .unwrap(),
    ))
}
fn u64_at(bytes: &[u8], at: usize) -> io::Result<u64> {
    Ok(u64::from_be_bytes(
        bytes
            .get(at..at + 8)
            .ok_or_else(invalid)?
            .try_into()
            .unwrap(),
    ))
}
fn atoms(mut bytes: &[u8]) -> io::Result<Vec<Atom<'_>>> {
    let mut out = Vec::new();
    while !bytes.is_empty() {
        let size = u32_at(bytes, 0)? as u64;
        let header = if size == 1 { 16 } else { 8 };
        let size = if size == 1 {
            u64_at(bytes, 8)?
        } else if size == 0 {
            bytes.len() as u64
        } else {
            size
        };
        if size < header || size > bytes.len() as u64 {
            return Err(invalid());
        }
        out.push(Atom {
            kind: bytes.get(4..8).ok_or_else(invalid)?.try_into().unwrap(),
            data: &bytes[header as usize..size as usize],
        });
        bytes = &bytes[size as usize..];
    }
    Ok(out)
}
fn child<'a>(bytes: &'a [u8], name: &[u8; 4]) -> io::Result<&'a [u8]> {
    atoms(bytes)?
        .into_iter()
        .find(|a| &a.kind == name)
        .map(|a| a.data)
        .ok_or_else(invalid)
}
fn table_count(bytes: &[u8], entry: usize, offset: usize) -> io::Result<usize> {
    let count = u32_at(bytes, 4)? as usize;
    if count > 2_000_000
        || count.checked_mul(entry).and_then(|n| n.checked_add(offset)) != Some(bytes.len())
    {
        return Err(invalid());
    }
    Ok(count)
}
#[derive(Clone, Copy)]
struct Extent {
    offset: u64,
    size: u64,
}
fn metadata(moov: &[u8]) -> io::Result<(Vec<u8>, Vec<Extent>, u32, u32)> {
    let tracks: Vec<_> = atoms(moov)?
        .into_iter()
        .filter(|a| a.kind == *b"trak")
        .collect();
    if tracks.len() != 1 {
        return Err(invalid());
    }
    let track = tracks[0].data;
    let tkhd = child(track, b"tkhd")?;
    let id = u32_at(tkhd, if tkhd.first() == Some(&1) { 20 } else { 12 })?;
    let mdia = child(track, b"mdia")?;
    if child(mdia, b"hdlr")?.get(8..12) != Some(b"soun") {
        return Err(invalid());
    }
    let stbl = child(child(mdia, b"minf")?, b"stbl")?;
    let stsd = child(stbl, b"stsd")?;
    if u32_at(stsd, 4)? != 1 {
        return Err(invalid());
    }
    let descriptions = atoms(stsd.get(8..).ok_or_else(invalid)?)?;
    if descriptions.len() != 1 || descriptions[0].kind != *b"fLaC" {
        return Err(invalid());
    }
    let entry = descriptions[0].data;
    if entry.get(8..10) != Some(&[0, 0]) {
        return Err(invalid());
    }
    let config = child(entry.get(28..).ok_or_else(invalid)?, b"dfLa")?;
    if config.get(..4) != Some(&[0, 0, 0, 0]) {
        return Err(invalid());
    }
    let mut meta = config[4..].to_vec();
    let mut cursor = 0;
    let mut last = 0;
    while cursor < meta.len() {
        let typ = *meta.get(cursor).ok_or_else(invalid)? & 127;
        let length = ((u32_at(&meta, cursor)? & 0x00ff_ffff) as usize)
            .checked_add(4)
            .ok_or_else(invalid)?;
        if (cursor == 0 && (typ != 0 || length != 38))
            || typ == 127
            || cursor
                .checked_add(length)
                .is_none_or(|end| end > meta.len())
        {
            return Err(invalid());
        }
        meta[cursor] &= 127;
        last = cursor;
        cursor += length;
    }
    if meta.len() < 38 {
        return Err(invalid());
    }
    meta[last] |= 128;
    let trex = atoms(moov)?
        .into_iter()
        .find(|a| a.kind == *b"mvex")
        .map(|mvex| atoms(mvex.data))
        .transpose()?
        .unwrap_or_default();
    let default_size = trex
        .into_iter()
        .find(|a| a.kind == *b"trex" && u32_at(a.data, 4).ok() == Some(id))
        .map(|a| u32_at(a.data, 16))
        .transpose()?
        .unwrap_or(0);
    let stsz = child(stbl, b"stsz")?;
    let count = u32_at(stsz, 8)? as usize;
    let fixed = u32_at(stsz, 4)?;
    if count > 2_000_000 {
        return Err(invalid());
    }
    if count == 0 {
        return Ok((meta, vec![], id, default_size));
    }
    if stsz.len() != 12 + if fixed == 0 { count * 4 } else { 0 } {
        return Err(invalid());
    }
    let tables = atoms(stbl)?;
    let offsets = tables
        .iter()
        .find(|a| a.kind == *b"stco" || a.kind == *b"co64")
        .ok_or_else(invalid)?;
    let wide = offsets.kind == *b"co64";
    let chunks = table_count(offsets.data, if wide { 8 } else { 4 }, 8)?;
    let stsc = child(stbl, b"stsc")?;
    let rows = table_count(stsc, 12, 8)?;
    if rows == 0 || u32_at(stsc, 8)? != 1 {
        return Err(invalid());
    }
    let mut extents = Vec::new();
    let mut sample = 0;
    let mut row = 0;
    for chunk in 1..=chunks {
        while row + 1 < rows && u32_at(stsc, 8 + (row + 1) * 12)? as usize <= chunk {
            if u32_at(stsc, 8 + (row + 1) * 12)? <= u32_at(stsc, 8 + row * 12)? {
                return Err(invalid());
            }
            row += 1
        }
        if u32_at(stsc, 16 + row * 12)? != 1 {
            return Err(invalid());
        }
        let per_chunk = u32_at(stsc, 12 + row * 12)? as usize;
        if per_chunk == 0 || per_chunk > count - sample {
            return Err(invalid());
        }
        let mut offset = if wide {
            u64_at(offsets.data, 8 + (chunk - 1) * 8)?
        } else {
            u32_at(offsets.data, 8 + (chunk - 1) * 4)? as u64
        };
        for _ in 0..per_chunk {
            let size = if fixed == 0 {
                u32_at(stsz, 12 + sample * 4)?
            } else {
                fixed
            } as u64;
            if size < 2 {
                return Err(invalid());
            }
            extents.push(Extent { offset, size });
            offset = offset.checked_add(size).ok_or_else(invalid)?;
            sample += 1
        }
    }
    if sample != count {
        return Err(invalid());
    }
    Ok((meta, extents, id, default_size))
}
fn fragment(
    bytes: &[u8],
    moof_start: u64,
    next_data: u64,
    id: u32,
    trex_size: u32,
) -> io::Result<Vec<Extent>> {
    let trafs: Vec<_> = atoms(bytes)?
        .into_iter()
        .filter(|a| a.kind == *b"traf")
        .collect();
    if trafs.len() != 1 {
        return Err(invalid());
    }
    let traf = trafs[0].data;
    let tfhd = child(traf, b"tfhd")?;
    let flags = u32_at(tfhd, 0)? & 0xff_ffff;
    if u32_at(tfhd, 4)? != id {
        return Err(invalid());
    }
    let mut at = 8;
    let base = if flags & 1 != 0 {
        let n = u64_at(tfhd, at)?;
        at += 8;
        n
    } else {
        moof_start
    };
    if flags & 2 != 0 {
        if u32_at(tfhd, at)? != 1 {
            return Err(invalid());
        }
        at += 4
    }
    if flags & 8 != 0 {
        at += 4
    }
    let default_size = if flags & 16 != 0 {
        u32_at(tfhd, at)?
    } else {
        trex_size
    };
    let mut out = Vec::new();
    let mut cursor = if flags & 1 != 0 { base } else { next_data };
    for run in atoms(traf)?.into_iter().filter(|a| a.kind == *b"trun") {
        let data = run.data;
        let flags = u32_at(data, 0)? & 0xff_ffff;
        let count = u32_at(data, 4)? as usize;
        if count > 2_000_000 {
            return Err(invalid());
        }
        let mut at = 8;
        if flags & 1 != 0 {
            let delta = u32_at(data, at)? as i32 as i64;
            cursor = if delta >= 0 {
                base.checked_add(delta as u64)
            } else {
                base.checked_sub(delta.unsigned_abs())
            }
            .ok_or_else(invalid)?;
            at += 4
        }
        if flags & 4 != 0 {
            at += 4
        }
        for _ in 0..count {
            if flags & 0x100 != 0 {
                at += 4
            }
            let size = if flags & 0x200 != 0 {
                let n = u32_at(data, at)?;
                at += 4;
                n
            } else {
                default_size
            } as u64;
            if flags & 0x400 != 0 {
                at += 4
            }
            if flags & 0x800 != 0 {
                at += 4
            }
            if size < 2 || at > data.len() {
                return Err(invalid());
            }
            out.push(Extent {
                offset: cursor,
                size,
            });
            cursor = cursor.checked_add(size).ok_or_else(invalid)?;
        }
        if at != data.len() {
            return Err(invalid());
        }
    }
    if out.is_empty() {
        return Err(invalid());
    }
    Ok(out)
}
/// Only supports a single unencrypted FLAC audio track. File buffers stay bounded.
pub fn export(source: &Path, target: &Path) -> io::Result<u64> {
    let mut input = File::open(source)?;
    let length = input.metadata()?.len();
    let mut pos = 0;
    let mut moov = None;
    let mut fragments = Vec::new();
    let mut metadata_bytes = 0u64;
    let mut media = Vec::new();
    while pos < length {
        input.seek(SeekFrom::Start(pos))?;
        let mut header = [0; 8];
        input.read_exact(&mut header)?;
        let size = u32_at(&header, 0)? as u64;
        let (kind, header_size, size) = (
            <[u8; 4]>::try_from(&header[4..]).unwrap(),
            if size == 1 { 16 } else { 8 },
            if size == 1 {
                let mut n = [0; 8];
                input.read_exact(&mut n)?;
                u64::from_be_bytes(n)
            } else if size == 0 {
                length - pos
            } else {
                size
            },
        );
        if size < header_size || pos.checked_add(size).is_none_or(|end| end > length) {
            return Err(invalid());
        }
        let payload = pos + header_size;
        if kind == *b"moov" || kind == *b"moof" {
            metadata_bytes = metadata_bytes
                .checked_add(size - header_size)
                .ok_or_else(invalid)?;
            if size - header_size > 16 * 1024 * 1024 || metadata_bytes > 64 * 1024 * 1024 {
                return Err(invalid());
            }
            let mut bytes = vec![0; (size - header_size) as usize];
            input.read_exact(&mut bytes)?;
            if kind == *b"moov" {
                if moov.is_some() {
                    return Err(invalid());
                }
                moov = Some(bytes)
            } else {
                fragments.push((pos, bytes))
            }
        } else if kind == *b"mdat" {
            if media.len() >= 2_000_000 {
                return Err(invalid());
            }
            media.push(Extent {
                offset: payload,
                size: size - header_size,
            })
        }
        pos += size;
    }
    let (meta, mut extents, id, default_size) = metadata(&moov.ok_or_else(invalid)?)?;
    for (offset, bytes) in fragments {
        let next = media
            .iter()
            .find(|range| range.offset > offset)
            .ok_or_else(invalid)?
            .offset;
        let frames = fragment(&bytes, offset, next, id, default_size)?;
        if extents.len().saturating_add(frames.len()) > 2_000_000 {
            return Err(invalid());
        }
        extents.extend(frames);
    }
    if extents.is_empty() {
        return Err(invalid());
    }
    // Validate every sample before creating a result, so mixed tracks or padding
    // can never be emitted as FLAC. Frames are copied byte-for-byte in sample order.
    for e in &extents {
        if !media.iter().any(|m| {
            e.offset >= m.offset
                && e.offset
                    .checked_add(e.size)
                    .is_some_and(|end| end <= m.offset + m.size)
        }) {
            return Err(invalid());
        }
        input.seek(SeekFrom::Start(e.offset))?;
        let mut sync = [0; 2];
        input.read_exact(&mut sync)?;
        if sync[0] != 255 || sync[1] & 0xfe != 0xf8 {
            return Err(invalid());
        }
    }
    let mut output = File::create(target)?;
    output.write_all(b"fLaC")?;
    output.write_all(&meta)?;
    let mut written = 4 + meta.len() as u64;
    let mut buffer = [0; 65536];
    for e in extents {
        input.seek(SeekFrom::Start(e.offset))?;
        let mut remaining = e.size;
        while remaining > 0 {
            let n = remaining.min(buffer.len() as u64) as usize;
            input.read_exact(&mut buffer[..n])?;
            output.write_all(&buffer[..n])?;
            remaining -= n as u64;
            written += n as u64
        }
    }
    output.sync_all()?;
    Ok(written)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn damaged_atom_sizes_are_rejected() {
        assert!(atoms(&[0, 0, 0, 7, b'f', b'r', b'e', b'e']).is_err());
        assert!(atoms(&[0, 0, 0, 20, b'm', b'o', b'o', b'v']).is_err())
    }
    #[test]
    #[ignore = "requires BILIMUSIC_FFMPEG test executable"]
    fn real_flac_frames_round_trip_without_reencoding() {
        use std::process::Command;
        let ffmpeg = std::env::var("BILIMUSIC_FFMPEG").expect("set BILIMUSIC_FFMPEG");
        let dir = std::env::temp_dir().join(format!("bili-flac-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let run = |args: Vec<String>| {
            let out = Command::new(&ffmpeg).args(args).output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            out.stdout
        };
        let path = |name: &str| dir.join(name).to_str().unwrap().to_owned();
        run(vec![
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=997:duration=1",
            "-ar",
            "96000",
            "-ac",
            "2",
            "-sample_fmt",
            "s32",
            "-c:a",
            "flac",
            "-y",
        ]
        .into_iter()
        .map(str::to_owned)
        .chain([path("original.flac")])
        .collect());
        let hash = |file: String| {
            run(vec![
                "-v".into(),
                "error".into(),
                "-i".into(),
                file,
                "-f".into(),
                "hash".into(),
                "-hash".into(),
                "sha256".into(),
                "-".into(),
            ])
        };
        let expected = hash(path("original.flac"));
        for fragmented in [false, true] {
            let name = if fragmented {
                "fragmented.mp4"
            } else {
                "normal.mp4"
            };
            let mut args = vec![
                "-v".into(),
                "error".into(),
                "-i".into(),
                path("original.flac"),
                "-c:a".into(),
                "copy".into(),
                "-strict".into(),
                "-2".into(),
                "-y".into(),
            ];
            if fragmented {
                args.extend(["-movflags".into(), "frag_keyframe+empty_moov".into()])
            }
            args.push(path(name));
            run(args);
            let result = dir.join(format!("{name}.flac"));
            export(&dir.join(name), &result).unwrap();
            assert_eq!(&std::fs::read(&result).unwrap()[..4], b"fLaC");
            assert_eq!(hash(result.to_str().unwrap().into()), expected);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
