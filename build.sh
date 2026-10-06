#!/bin/sh
# Builds index.html (GitHub Pages) from src/page.html (also the claude.ai artifact source).
# The static build adds supabase-js so shared boards (?board=...) sync through Supabase song.boards.
cd "$(dirname "$0")"
{
  printf '<!doctype html>\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="description" content="挑歌、排進婚宴流程，和另一半、婚顧一起編同一份婚禮歌單。">\n'
  printf '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js"></script>\n'
  printf '</head>\n<body>\n'
  cat src/page.html
  printf '\n</body>\n</html>\n'
} > index.html
