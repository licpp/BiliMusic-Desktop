//! Compatibility stream for an old Android decoder that stalls with the AVC
//! frame-number gaps flag set. Only exact in-band copies of the configured SPS
//! are changed, keeping media and index byte offsets intact.
use super::fragmented_mp4::boxes;

pub(super) struct AvcPatch {
    pattern: Vec<u8>,
    flag_byte: usize,
    replacement: u8,
}

impl AvcPatch {
    pub(super) fn from_init(bytes: &[u8]) -> Option<Self> {
        let movie = child(bytes, b"moov")?;
        child(movie, b"mvex")?;
        let mut tracks = boxes(movie).filter(|(kind, _, _)| *kind == b"trak");
        let (_, track, _) = tracks.next()?;
        if tracks.next().is_some() {
            return None;
        }
        let media = child(track, b"mdia")?;
        if child(media, b"hdlr")?.get(8..12)? != b"vide" {
            return None;
        }
        let sample_table = child(child(media, b"minf")?, b"stbl")?;
        let descriptions = child(sample_table, b"stsd")?;
        if descriptions.get(..8)? != [0, 0, 0, 0, 0, 0, 0, 1] {
            return None;
        }
        let avc = child(descriptions.get(8..)?, b"avc1")?;
        let config = child(avc.get(78..)?, b"avcC")?;
        // AVCDecoderConfigurationRecord version 1, four-byte NAL sizes, one SPS.
        if config.first() != Some(&1) || config.get(4)? & 3 != 3 || config.get(5)? & 31 != 1 {
            return None;
        }
        let len = u16::from_be_bytes(config.get(6..8)?.try_into().ok()?) as usize;
        let sps = config.get(8..8 + len)?;
        if len > 256 || sps.first()? & 0x9f != 7 {
            return None;
        }
        let mut rbsp = Vec::with_capacity(len - 1);
        let mut zeros = 0;
        for &byte in &sps[1..] {
            if zeros == 2 && byte == 3 {
                zeros = 0;
                continue;
            }
            rbsp.push(byte);
            zeros = if byte == 0 { zeros + 1 } else { 0 };
        }
        let bit = gap_flag(&rbsp)?;
        rbsp[bit / 8] &= !(1 << (7 - bit % 8));
        let mut encoded = vec![sps[0]];
        zeros = 0;
        for byte in rbsp {
            if zeros == 2 && byte <= 3 {
                encoded.push(3);
                zeros = 0;
            }
            encoded.push(byte);
            zeros = if byte == 0 { zeros + 1 } else { 0 };
        }
        // Leave layouts that need emulation-prevention bytes moved or inserted intact.
        if encoded.len() != len {
            return None;
        }
        let mut differences = (0..len).filter(|&i| sps[i] != encoded[i]);
        let flag = differences.next()?;
        if differences.next().is_some() {
            return None;
        }
        Some(Self {
            pattern: [(len as u32).to_be_bytes().as_slice(), sps].concat(),
            flag_byte: 4 + flag,
            replacement: encoded[flag],
        })
    }

    pub(super) fn context(&self) -> u64 {
        self.pattern.len() as u64 - 1
    }

    // Keep only enough bytes between chunks to recognize an SPS split over
    // deliveries. Already examined positions do not need to be scanned again.
    pub(super) fn inspect(&self, pending: &mut Vec<u8>) -> Vec<u8> {
        let ready = pending.len().saturating_sub(self.context() as usize);
        for start in 0..ready {
            let end = start + self.pattern.len();
            if pending[start..end] == self.pattern {
                pending[start + self.flag_byte] = self.replacement;
            }
        }
        let tail = pending.split_off(ready);
        std::mem::replace(pending, tail)
    }
}

fn child<'a>(bytes: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(bytes)
        .find(|(name, _, _)| *name == kind)
        .map(|(_, body, _)| body)
}

fn gap_flag(rbsp: &[u8]) -> Option<usize> {
    let mut bits = Bits {
        bytes: rbsp,
        position: 0,
    };
    // Scope the workaround to the observed progressive High, 8-bit 4:2:0
    // stream format with frame-based POC and no custom scaling matrices.
    if bits.read(8)? != 100 {
        return None;
    }
    bits.read(16)?; // constraint flags, level_idc
    bits.ue()?; // seq_parameter_set_id
    if bits.ue()? != 1 || bits.ue()? != 0 || bits.ue()? != 0 || bits.read(2)? & 1 != 0 {
        return None;
    }
    bits.ue()?; // log2_max_frame_num_minus4
    if bits.ue()? != 0 {
        return None;
    }
    bits.ue()?; // log2_max_pic_order_cnt_lsb_minus4
    bits.ue()?; // max_num_ref_frames
    let flag = bits.position;
    if bits.read(1)? != 1 {
        return None;
    }
    bits.ue()?; // pic_width_in_mbs_minus1
    bits.ue()?; // pic_height_in_map_units_minus1
    (bits.read(1)? == 1).then_some(flag) // frame_mbs_only_flag
}

struct Bits<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl Bits<'_> {
    fn read(&mut self, len: u32) -> Option<u32> {
        let mut value = 0;
        for _ in 0..len {
            let bit = (self.bytes.get(self.position / 8)? >> (7 - self.position % 8)) & 1;
            value = (value << 1) | u32::from(bit);
            self.position += 1;
        }
        Some(value)
    }

    fn ue(&mut self) -> Option<u32> {
        let mut zeros = 0;
        while self.read(1)? == 0 {
            zeros += 1;
            if zeros == 32 {
                return None;
            }
        }
        Some((1u32 << zeros) - 1 + self.read(zeros)?)
    }
}

#[cfg(test)]
pub(super) fn fixture() -> (Vec<u8>, usize) {
    fn atom(name: &[u8; 4], body: &[u8]) -> Vec<u8> {
        [(body.len() as u32 + 8).to_be_bytes().as_slice(), name, body].concat()
    }
    const SPS: &[u8] = &[
        0x27, 0x64, 0, 0x33, 0xac, 0x13, 0x1a, 0x58, 0x28, 0x0b, 0xfe, 0x59, 0xa8, 8, 8, 0x0a, 0,
        0, 3, 0, 2, 0, 0, 3, 0, 0x78, 0x1e, 0x2c, 0x49, 0x0b,
    ];
    let config = [&[1, 0x64, 0, 0x33, 0xff, 0xe1, 0, SPS.len() as u8], SPS].concat();
    let avc = atom(
        b"avc1",
        &[&[0; 78], atom(b"avcC", &config).as_slice()].concat(),
    );
    let stsd = atom(
        b"stsd",
        &[&[0, 0, 0, 0, 0, 0, 0, 1], avc.as_slice()].concat(),
    );
    let minf = atom(b"minf", &atom(b"stbl", &stsd));
    let mdia = atom(
        b"mdia",
        &[atom(b"hdlr", b"\0\0\0\0\0\0\0\0vide"), minf].concat(),
    );
    let mut media = atom(
        b"moov",
        &[atom(b"trak", &mdia), atom(b"mvex", &[])].concat(),
    );
    let flag_offset = media.len() + 8 + 4 + 7;
    let nal = [(SPS.len() as u32).to_be_bytes().as_slice(), SPS].concat();
    media.extend(atom(b"mdat", &nal));
    (media, flag_offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_in_band_sps_is_repaired_across_every_read_boundary() {
        let (original, flag) = fixture();
        let patch = AvcPatch::from_init(&original).unwrap();
        let mut expected = original.clone();
        expected[flag] = 0x50;
        for at in 0..original.len() {
            let mut pending = original[..at].to_vec();
            let mut actual = patch.inspect(&mut pending);
            pending.extend_from_slice(&original[at..]);
            actual.extend(patch.inspect(&mut pending));
            actual.extend(pending);
            assert_eq!(actual, expected, "split offset {at}");
        }
    }

    #[test]
    fn unrelated_or_already_compatible_sps_is_unchanged() {
        let (mut data, _) = fixture();
        let avcc = data.windows(4).position(|word| word == b"avcC").unwrap();
        data[avcc + 4 + 8 + 7] = 0x50;
        assert!(AvcPatch::from_init(&data).is_none());
        let (mut data, _) = fixture();
        let entry = data.windows(4).position(|word| word == b"avc1").unwrap();
        data[entry..entry + 4].copy_from_slice(b"hvc1");
        assert!(AvcPatch::from_init(&data).is_none());
    }
}
