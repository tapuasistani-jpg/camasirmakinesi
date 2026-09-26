#!/usr/bin/env bash
set +e
lane="${1:-depo}"
if [ -z "$POSTGRES_URL" ] && [ -z "$DATABASE_URL" ] && [ -z "$POSTGRES_URL_NON_POOLING" ]; then
  echo "GitHub secret eksik: POSTGRES_URL"
  exit 1
fi

run_tsx() {
  npx --no-install tsx --tsconfig tsconfig.scripts.json "$@"
}

sira_al() {
  rm -f sira.json
  run_tsx scripts/tara-next.ts "$lane" > /tmp/tara-next.out 2>/tmp/tara-next.err
  if [ -f sira.json ]; then
    cat sira.json
  else
    cat /tmp/tara-next.out
  fi
}

agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
deadline=$((SECONDS + 200 * 60))
px=()
wait_tur=3
wait_diger=2
wait_ek=1
wait_hata=90
kind_bos="tur"
if [ "$lane" = "site" ]; then
  kind_bos="site"
fi
if [ -n "$AMAZON_PROXY" ]; then
  proxy="$AMAZON_PROXY"
  case "$proxy" in
    *://*) ;;
    *) proxy="http://$proxy" ;;
  esac
  px=(-x "$proxy")
  wait_tur=1
  wait_diger=1
  wait_ek=0
  wait_hata=45
  echo "Amazon proxy acik, $lane ajanı."
else
  echo "Amazon proxy yok, $lane ajanı normal tempo."
fi

curl -sS -m 30 "${px[@]}" -c jar.txt -A "$agent" \
  -H "Accept-Language: tr-TR,tr;q=0.9" \
  "https://www.amazon.com.tr/" -o /dev/null || true

target=$(sira_al)
if [ -s /tmp/tara-next.err ]; then
  echo "sira hata: $(head -c 400 /tmp/tara-next.err)"
fi

bos=0
while [ $SECONDS -lt $deadline ]; do
  url=$(echo "$target" | jq -r '.url // empty' 2>/dev/null || true)
  kind=$(echo "$target" | jq -r --arg d "$kind_bos" '.kind // $d' 2>/dev/null || true)
  label=$(echo "$target" | jq -r '.label // ""' 2>/dev/null || true)
  if [ -z "$url" ]; then
    bos=$((bos + 1))
    echo "Sıradaki adres gelmedi ($bos/3)."
    echo "stdout: $(printf '%s' "$target" | head -c 300)"
    if [ -s /tmp/tara-next.err ]; then
      echo "stderr: $(head -c 500 /tmp/tara-next.err)"
    fi
    if [ "$bos" -ge 3 ]; then
      echo "Üç kez boş sıra. GitHub secret POSTGRES_URL Vercel'deki ile aynı mı bak."
      exit 1
    fi
    sleep 5
    target=$(sira_al)
    continue
  fi
  bos=0
  echo "$kind · $label · $url"
  code=$(curl -sS --compressed -m 45 "${px[@]}" -b jar.txt -c jar.txt -A "$agent" \
    -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
    -H "Accept-Language: tr-TR,tr;q=0.9,en;q=0.8" \
    -H "Upgrade-Insecure-Requests: 1" \
    -H "Referer: https://www.amazon.com.tr/" \
    -w '%{http_code}' -o sayfa.html "$url" || echo "000")
  code=$(printf '%s' "$code" | tr -cd '0-9' | tail -c 3)
  if [ "$code" != "200" ]; then
    echo "Amazon $code, 2 saniye sonra ayni sayfa tekrar."
    sleep 2
    code=$(curl -sS --compressed -m 45 "${px[@]}" -b jar.txt -c jar.txt -A "$agent" \
      -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
      -H "Accept-Language: tr-TR,tr;q=0.9,en;q=0.8" \
      -H "Upgrade-Insecure-Requests: 1" \
      -H "Referer: https://www.amazon.com.tr/" \
      -w '%{http_code}' -o sayfa.html "$url" || echo "000")
    code=$(printf '%s' "$code" | tr -cd '0-9' | tail -c 3)
  fi
  if [ "$code" != "200" ]; then
    if [ "$code" = "403" ] || [ "$code" = "429" ] || [ "$code" = "503" ]; then
      echo "Amazon $code verdi, ${wait_hata} saniye bekleniyor."
      sleep "$wait_hata"
    else
      echo "Amazon $code verdi, 8 saniye sonra ayni sayfa."
      sleep 8
    fi
    continue
  fi
  jq -n --arg url "$url" --arg kind "$kind" --arg label "$label" --arg lane "$lane" --rawfile html sayfa.html \
    '{url:$url,kind:$kind,label:$label,html:$html,lane:$lane}' > gonder.json || true
  cevap=$(run_tsx scripts/tara-feed.ts gonder.json 2>/tmp/tara-feed.err || true)
  echo "$cevap" | head -c 400
  echo
  if [ -s /tmp/tara-feed.err ]; then
    echo "feed hata: $(head -c 400 /tmp/tara-feed.err)"
  fi
  extras=$(echo "$target" | jq -c '.extra // []' 2>/dev/null || echo "[]")
  yeni=$(echo "$cevap" | jq -c '.next // empty' 2>/dev/null || true)
  if [ -n "$yeni" ] && [ "$yeni" != "null" ]; then
    target="$yeni"
  else
    target=$(sira_al)
  fi
  if [ "$extras" != "[]" ] && [ "$extras" != "null" ]; then
    echo "$extras" | jq -c '.[]' | while read -r extra; do
      eurl=$(echo "$extra" | jq -r '.url // empty')
      ekind=$(echo "$extra" | jq -r '.kind // "takip"')
      elabel=$(echo "$extra" | jq -r '.label // ""')
      [ -z "$eurl" ] && continue
      echo "ek · $ekind · $elabel · $eurl"
      ecode=$(curl -sS --compressed -m 45 "${px[@]}" -b jar.txt -c jar.txt -A "$agent" \
        -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
        -H "Accept-Language: tr-TR,tr;q=0.9,en;q=0.8" \
        -H "Referer: https://www.amazon.com.tr/" \
        -w '%{http_code}' -o sayfa.html "$eurl" || echo "000")
      ecode=$(printf '%s' "$ecode" | tr -cd '0-9' | tail -c 3)
      if [ "$ecode" != "200" ]; then
        sleep 2
        ecode=$(curl -sS --compressed -m 45 "${px[@]}" -b jar.txt -c jar.txt -A "$agent" \
          -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
          -H "Accept-Language: tr-TR,tr;q=0.9,en;q=0.8" \
          -H "Referer: https://www.amazon.com.tr/" \
          -w '%{http_code}' -o sayfa.html "$eurl" || echo "000")
        ecode=$(printf '%s' "$ecode" | tr -cd '0-9' | tail -c 3)
      fi
      [ "$ecode" != "200" ] && continue
      jq -n --arg url "$eurl" --arg kind "$ekind" --arg label "$elabel" --arg lane "$lane" --rawfile html sayfa.html \
        '{url:$url,kind:$kind,label:$label,html:$html,quiet:true,lane:$lane}' > gonder.json || true
      run_tsx scripts/tara-feed.ts gonder.json 2>/tmp/tara-feed.err | head -c 200 || true
      echo
      sleep "$wait_ek"
    done
  fi
  if [ "$kind" = "tur" ] || [ "$kind" = "site" ]; then
    sleep "$wait_tur"
  else
    sleep "$wait_diger"
  fi
done
exit 0
