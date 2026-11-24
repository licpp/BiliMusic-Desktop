use image::DynamicImage;

pub(super) fn render(
    max_width: u32,
    max_height: u32,
    dpi: u32,
    artwork: Option<&DynamicImage>,
    logo: Option<&DynamicImage>,
    dark: bool,
) -> Option<(u32, Vec<u8>)> {
    // Keep the same square canvas when a cover replaces the loading placeholder.
    let side = max_width.min(max_height).min(176 * dpi / 96);
    if side == 0 {
        return None;
    }
    let background = if dark {
        [40, 29, 14, 255]
    } else {
        [250, 246, 243, 255]
    };
    let mut pixels = background.repeat((side * side) as usize);

    if let Some(image) = artwork.or(logo) {
        let extent = if artwork.is_some() {
            side - 2 * (side / 20)
        } else {
            (side / 2).max(1)
        };
        let scaled = image.thumbnail(extent, extent).into_rgba8();
        let x = (side - scaled.width()) / 2;
        let y = (side - scaled.height()) / 2;
        for (column, row, pixel) in scaled.enumerate_pixels() {
            let offset = (((y + row) * side + x + column) * 4) as usize;
            let alpha = u16::from(pixel[3]);
            for channel in 0..3 {
                // A 32-bit top-down DIB stores channels in BGRA order.
                pixels[offset + channel] = ((u16::from(pixel[2 - channel]) * alpha
                    + u16::from(background[channel]) * (255 - alpha))
                    / 255) as u8;
            }
        }
    }
    Some((side, pixels))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn solid(width: u32, height: u32) -> DynamicImage {
        RgbaImage::from_pixel(width, height, Rgba([230, 47, 10, 255])).into()
    }

    #[test]
    fn loading_and_loaded_artwork_fit_the_same_dwm_bounds() {
        let logo = solid(64, 64);
        let cover = solid(192, 108);
        for (width, height, dpi, expected) in [
            (260, 130, 144, 130),
            (90, 200, 192, 90),
            (300, 300, 96, 176),
            (900, 900, 192, 352),
            (12, 12, 96, 12),
        ] {
            for artwork in [None, Some(&cover), Some(&logo)] {
                let (side, pixels) =
                    render(width, height, dpi, artwork, Some(&logo), true).unwrap();
                assert_eq!(side, expected);
                assert_eq!(pixels.len(), (expected * expected * 4) as usize);
            }
        }
        assert!(render(200, 0, 96, None, Some(&logo), true).is_none());
    }

    #[test]
    fn landscape_artwork_is_centered_and_keeps_its_aspect_ratio() {
        let cover = solid(200, 100);
        let (side, pixels) = render(100, 100, 96, Some(&cover), None, false).unwrap();
        let px = |x, y| {
            let start = ((y * side + x) * 4) as usize;
            &pixels[start..start + 4]
        };
        let background = [250, 246, 243, 255];
        let artwork = [10, 47, 230, 255];
        assert_eq!(px(5, 26), background);
        assert_eq!(px(5, 27), artwork);
        assert_eq!(px(94, 71), artwork);
        assert_eq!(px(95, 71), background);
        assert_eq!(px(94, 72), background);
    }
}
