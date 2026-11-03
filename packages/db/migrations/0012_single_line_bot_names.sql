-- Bot names are one line of plain text (contract 1.8.0). Names stored before
-- that rule are normalised here, archived bots' too, since task logs still
-- show them:
-- - each run of refused characters (every control character, LS and PS,
--   bidirectional controls and zero-width characters) becomes one space;
-- - the result is trimmed as JavaScript's trim() trims, and an empty one
--   becomes "Bot";
-- - an active bot whose new name another active bot of its owner holds,
--   ignoring case, takes " (2)", " (3)", ...: the first number free. Names
--   that were already valid never change, and among the renamed bots the
--   oldest (created_at, then id) goes first, so it keeps the plain name;
-- - the base is cut, and trimmed again, so that the name stays within the
--   contract's 60 characters, counted in UTF-16 code units as it counts them.
DO $$
DECLARE
  refused CONSTANT text := E'[\\u0001-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069\\u200B-\\u200D\\uFEFF]+';
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
