use rusqlite::{Connection, params};

pub struct SearchHistoryRepository;

impl SearchHistoryRepository {
    pub fn record(connection: &Connection, query: &str) -> rusqlite::Result<()> {
        connection.execute("DELETE FROM search_history WHERE query=?1", params![query])?;
        connection.execute(
            "INSERT INTO search_history(query,searched_at) VALUES (?1,CURRENT_TIMESTAMP)",
            params![query],
        )?;
        connection.execute(
            "DELETE FROM search_history WHERE query NOT IN
             (SELECT query FROM search_history ORDER BY searched_at DESC,rowid DESC LIMIT 30)",
            [],
        )?;
        Ok(())
    }

    pub fn list(connection: &Connection) -> rusqlite::Result<Vec<String>> {
        let mut statement = connection.prepare(
            "SELECT query FROM search_history ORDER BY searched_at DESC,rowid DESC LIMIT 30",
        )?;
        statement.query_map([], |row| row.get(0))?.collect()
    }

    pub fn clear(connection: &Connection) -> rusqlite::Result<()> {
        connection.execute("DELETE FROM search_history", [])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_query_moves_to_front_and_clear_removes_all() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE search_history(query TEXT PRIMARY KEY,searched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);").unwrap();
        SearchHistoryRepository::record(&connection, "first").unwrap();
        SearchHistoryRepository::record(&connection, "second").unwrap();
        SearchHistoryRepository::record(&connection, "first").unwrap();
        assert_eq!(
            SearchHistoryRepository::list(&connection)
                .unwrap()
                .first()
                .map(String::as_str),
            Some("first")
        );
        SearchHistoryRepository::clear(&connection).unwrap();
        assert!(
            SearchHistoryRepository::list(&connection)
                .unwrap()
                .is_empty()
        );
    }
}
