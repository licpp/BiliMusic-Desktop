UPDATE lyrics SET write_token=lower(hex(randomblob(16))) WHERE write_token='';
CREATE TRIGGER IF NOT EXISTS lyrics_insert_token AFTER INSERT ON lyrics
BEGIN UPDATE lyrics SET write_token=lower(hex(randomblob(16))) WHERE track_id=NEW.track_id; END;
CREATE TRIGGER IF NOT EXISTS lyrics_change_token AFTER UPDATE OF provider,provider_lyric_id,raw_text,parsed_json,selected_manually ON lyrics
WHEN OLD.provider IS NOT NEW.provider OR OLD.provider_lyric_id IS NOT NEW.provider_lyric_id OR OLD.raw_text IS NOT NEW.raw_text OR OLD.parsed_json IS NOT NEW.parsed_json OR OLD.selected_manually IS NOT NEW.selected_manually
BEGIN UPDATE lyrics SET write_token=lower(hex(randomblob(16))) WHERE track_id=NEW.track_id; END;
