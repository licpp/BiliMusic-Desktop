use super::error::CommandError;
use crate::infrastructure::database::Database;
use crate::infrastructure::providers::bilibili::{
    AccountProfile, BilibiliProvider, FavoriteFolder, FavoritePage, QrLogin, QrLoginStatus,
    SubscribedSeasonPage,
};
use crate::infrastructure::repositories::auth::AuthRepository;
use tauri::State;

#[tauri::command]
pub fn account_session(database: State<'_, Database>) -> Result<String, CommandError> {
    let c = database.0.lock().map_err(CommandError::database)?;
    crate::infrastructure::database::account_session(&c).map_err(CommandError::database)
}
pub(super) fn check_account_session(
    c: &rusqlite::Connection,
    expected: &str,
) -> Result<(), CommandError> {
    if crate::infrastructure::database::account_session(c).map_err(CommandError::database)?
        != expected
    {
        return Err(CommandError::validation("ACCOUNT_SESSION_EXPIRED"));
    }
    Ok(())
}

#[tauri::command]
pub async fn bili_qr_login_generate(
    provider: State<'_, BilibiliProvider>,
) -> Result<QrLogin, CommandError> {
    provider
        .qr_login_generate()
        .await
        .map_err(CommandError::bilibili)
}

#[tauri::command]
pub async fn bili_qr_login_poll(
    provider: State<'_, BilibiliProvider>,
    database: State<'_, Database>,
    key: String,
    sync: State<'_, crate::sync::SyncState>,
) -> Result<QrLoginStatus, CommandError> {
    if key.trim().is_empty() {
        return Err(CommandError::validation("二维码登录标识为空"));
    }
    let expected_session = account_session(database.clone())?;
    let candidate = BilibiliProvider::new().map_err(CommandError::provider)?;
    let status = candidate
        .qr_login_poll(&key)
        .await
        .map_err(CommandError::bilibili)?;
    if let Some(cookie) = &status.cookie_header {
        candidate.set_session_cookie(Some(cookie.clone())).await;
        let profile = candidate
            .account_profile()
            .await
            .map_err(CommandError::bilibili)?;
        let uid = profile
            .user_id
            .filter(|_| profile.logged_in)
            .ok_or_else(|| CommandError::validation("无法验证登录账号"))?;
        let _gate = sync.gate.lock().await;
        let _account = sync.account_gate.lock().await;
        if account_session(database.clone())? != expected_session {
            return Err(CommandError::validation("B 站账号已变更，请重试"));
        }
        sync.interrupt();
        provider
            .commit_session_cookie(Some(cookie.clone()), || {
                database.switch_profile(Some(uid), Some(cookie), Some(&expected_session))
            })
            .await
            .map_err(CommandError::database)?;
    }
    Ok(status)
}

#[tauri::command]
pub async fn bili_account_profile(
    provider: State<'_, BilibiliProvider>,
) -> Result<AccountProfile, CommandError> {
    provider
        .account_profile()
        .await
        .map_err(CommandError::bilibili)
}

#[tauri::command]
pub async fn bili_favorite_folders(
    provider: State<'_, BilibiliProvider>,
) -> Result<Vec<FavoriteFolder>, CommandError> {
    provider
        .favorite_folders()
        .await
        .map_err(CommandError::bilibili)
}

#[tauri::command]
pub async fn bili_subscribed_seasons(
    database: State<'_, Database>,
    expected_account_session: String,
    page: u32,
) -> Result<SubscribedSeasonPage, CommandError> {
    if page == 0 {
        return Err(CommandError::validation("无效的订阅合集页码"));
    }
    let cookie = {
        let c = database.0.lock().map_err(CommandError::database)?;
        check_account_session(&c, &expected_account_session)?;
        AuthRepository::get_cookie(&c, "bilibili")
            .map_err(CommandError::database)?
            .ok_or_else(|| CommandError::validation("请先登录 B 站账号"))?
    };
    let provider = BilibiliProvider::new().map_err(CommandError::provider)?;
    provider.set_session_cookie(Some(cookie)).await;
    let result = provider.subscribed_seasons(page).await;
    let c = database.0.lock().map_err(CommandError::database)?;
    check_account_session(&c, &expected_account_session)?;
    result.map_err(CommandError::bilibili)
}

#[tauri::command]
pub async fn bili_favorite_videos(
    provider: State<'_, BilibiliProvider>,
    folder_id: i64,
    page: u32,
) -> Result<FavoritePage, CommandError> {
    if folder_id <= 0 || page == 0 {
        return Err(CommandError::validation("无效的收藏夹或页码"));
    }
    provider
        .favorite_videos(folder_id, page)
        .await
        .map_err(CommandError::bilibili)
}

#[tauri::command]
pub async fn bili_logout(
    provider: State<'_, BilibiliProvider>,
    database: State<'_, Database>,
    sync: State<'_, crate::sync::SyncState>,
) -> Result<(), CommandError> {
    sync.interrupt();
    let _gate = sync.gate.lock().await;
    let _account = sync.account_gate.lock().await;
    provider
        .commit_session_cookie(None, || database.switch(None, None))
        .await
        .map_err(CommandError::database)
}
