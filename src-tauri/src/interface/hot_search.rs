use super::error::CommandError;
use crate::infrastructure::providers::bilibili::BilibiliProvider;
use crate::infrastructure::providers::hot_search::{HotSearchChart, HotSearchProvider};
use tauri::State;

#[tauri::command]
pub async fn hot_search_chart(
    provider: State<'_, HotSearchProvider>,
    bilibili: State<'_, BilibiliProvider>,
) -> Result<HotSearchChart, CommandError> {
    provider
        .chart(&bilibili)
        .await
        .map_err(CommandError::provider)
}
