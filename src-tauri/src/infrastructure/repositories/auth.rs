use rusqlite::{Connection, OptionalExtension, params};

pub struct AuthRepository;

impl AuthRepository {
    pub fn get_cookie(connection: &Connection, provider: &str) -> rusqlite::Result<Option<String>> {
        connection
            .query_row(
                "SELECT cookie_header FROM auth_session WHERE provider=?1",
                params![provider],
                |row| row.get(0),
            )
            .optional()
    }
    pub fn save_cookie(
        connection: &Connection,
        provider: &str,
        cookie: &str,
    ) -> rusqlite::Result<()> {
        connection.execute("INSERT INTO auth_session(provider,cookie_header) VALUES (?1,?2) ON CONFLICT(provider) DO UPDATE SET cookie_header=excluded.cookie_header,updated_at=CURRENT_TIMESTAMP", params![provider, cookie])?;
        Ok(())
    }
    pub fn clear(connection: &Connection, provider: &str) -> rusqlite::Result<()> {
        connection.execute(
            "DELETE FROM auth_session WHERE provider=?1",
            params![provider],
        )?;
        Ok(())
    }
}
