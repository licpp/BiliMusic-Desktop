pub fn valid_rank(value: &str) -> bool {
    value.len() == 20 && value.bytes().all(|b| b.is_ascii_digit())
}
pub fn valid_rule(value: &str) -> bool {
    matches!(
        value,
        "source:asc" | "source:desc" | "name:asc" | "name:desc" | "date:asc" | "date:desc"
    )
}
