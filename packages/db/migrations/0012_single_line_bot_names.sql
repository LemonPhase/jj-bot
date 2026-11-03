-- Bot names and roles are one line of plain text (contract 1.8.0). Those
-- stored before that rule are normalised here, archived bots' too, since task
-- logs still show them:
-- - each run of refused characters becomes one space. The set is the
--   contract's (a test compares the two over every code point): every
--   control character, LS and PS, the Bidi_Control set, the invisible U+180E,
--   U+200B, U+2060 to U+2064, U+206A to U+206F, U+FEFF and U+FFF9 to U+FFFB,
--   and the tag characters. Lone surrogates, which the contract also refuses,
--   cannot be stored in a UTF8 database;
-- - the result is trimmed as JavaScript's trim() trims. An empty name becomes
--   "Bot"; an empty role stays empty;
-- - an active bot whose new name another active bot of its owner holds,
--   ignoring case, takes " (2)", " (3)", ...: the first number free. Names
--   that were already valid never change, and among the renamed bots the
--   oldest (created_at, then id) goes first, so it keeps the plain name.
--   Roles are not unique and take no number;
-- - the base is cut, and trimmed again, so that the name stays within the
--   contract's 60 characters, counted in UTF-16 code units as it counts them.
-- The patterns' code points mean characters only in a UTF8 database, so any
-- other encoding is refused before anything changes.
DO $$
DECLARE
  refused CONSTANT text := E'[\\u0001-\\u001F\\u007F-\\u009F\\u061C\\u180E\\u200B\\u200E\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB\\U000E0000-\\U000E007F]+';
  -- What trim() still finds once the refused characters are spaces.
  blank CONSTANT text := E'[ \\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]+';
  astral CONSTANT text := E'[^\\U00010000-\\U0010FFFF]';
  bot record;
  base text;
  stem text;
  suffix text;
  candidate text;
  n integer;
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'JJ Bot needs a UTF8 database, and this one is encoded as %: migration 0012 cannot read bot names and roles in it without corrupting them. Create a database with ENCODING ''UTF8'' and restore a backup into it.', current_setting('server_encoding');
  END IF;

  UPDATE bots
  SET role = regexp_replace(
        regexp_replace(role, refused, ' ', 'g'),
        '^' || blank || '|' || blank || '$', '', 'g'),
      updated_at = now()
  WHERE role ~ refused;

  FOR bot IN
    SELECT id, owner_id, name, archived_at FROM bots
    WHERE name ~ refused
    ORDER BY created_at, id
  LOOP
    base := regexp_replace(bot.name, refused, ' ', 'g');
    base := regexp_replace(base, '^' || blank || '|' || blank || '$', '', 'g');
    IF base = '' THEN
      base := 'Bot';
    END IF;
    n := 1;
    LOOP
      suffix := CASE WHEN n = 1 THEN '' ELSE ' (' || n || ')' END;
      stem := base;
      WHILE char_length(stem || suffix)
          + char_length(regexp_replace(stem || suffix, astral, '', 'g')) > 60 LOOP
        stem := regexp_replace(left(stem, -1), blank || '$', '');
      END LOOP;
      candidate := stem || suffix;
      EXIT WHEN bot.archived_at IS NOT NULL OR NOT EXISTS (
        SELECT 1 FROM bots other
        WHERE other.owner_id = bot.owner_id
          AND other.archived_at IS NULL
          AND other.id <> bot.id
          AND lower(other.name) = lower(candidate)
      );
      n := n + 1;
    END LOOP;
    UPDATE bots SET name = candidate, updated_at = now() WHERE id = bot.id;
  END LOOP;
END $$;
