# Local Tao 0.35.3 patch

Source: crates.io `tao` 0.35.3 (MIT / Apache-2.0; see LICENSE).

In `src/platform_impl/ios/view.rs`, the Objective-C scene configuration
delegate callback must transfer its `UISceneConfiguration` into an autoreleased
return value. Returning `Retained::as_ptr(&config)` drops the owning reference
before UIKit retains it, causing a Release startup use-after-free. The callback
now returns `Retained::autorelease_return(config)`.

Reproduced with an iOS 27.2 Release simulator build; Debug did not reproduce.
