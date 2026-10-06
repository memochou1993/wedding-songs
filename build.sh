#!/bin/sh
# Builds index.html (GitHub Pages) from src/page.html (also the claude.ai artifact source).
# The static build adds supabase-js so shared boards (?board=...) sync through Supabase song.boards.
cd "$(dirname "$0")"
{
  printf '<!doctype html>\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n<meta name="description" content="依婚宴流程整理的英文、台語、日文、韓文婚禮歌，附歌詞大意、適合情境，以及常被誤用的地雷歌。">\n'
  printf '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js"></script>\n'
  printf '</head>\n<body>\n'
  cat src/page.html
  printf '\n</body>\n</html>\n'
} > index.html
