# ÇAMAŞIRMAKİNESİ

Amazon Depo alarmı. Site Vercel'de açılır, kod GitHub'da durur. Tarama, amazon.com.tr arama kutusunda **Amazon Depo** seçiliyken yapılır. Önce kutu boş aranır, sonra Mutfak, Elektronik ve diğer depo kategorileri aynı kutudan aranır. GitHub Actions 15 dakikada bir 8 sayfa ilerletir.

%80 ve üstü indirimde ürün adı Google sonuçlarında aranır.

- **EVET** — fiyat piyasa ortasının da belirgin altındadır, ya da site bu ürünü daha önce çok daha pahalı görmüştür. Telegram'a bu gider.
- **HAYIR** — çizili fiyat yüksektir, piyasa Amazon'a yakındır.
- **NET DEĞİL** — karşılaştıracak kadar dış fiyat çıkmamıştır.

Amazon, veri merkezi adreslerinden gelen taramayı robot kontrolüyle kesebilir. Olursa günlükte yazar ve o tur durur.

## Vercel

1. Bu depoyu Vercel'e bağla.
2. Storage → Create Database → Postgres. `POSTGRES_URL` kendiliğinden gelir.
3. Environment Variables:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `CRON_SECRET` — uzun rastgele bir yazı
   - `ADMIN_PASSWORD` — sitedeki kaydet ve tara butonları bunu sorar
4. Deploy.

Vercel'in ücretsiz planında kendi zamanlayıcısı günde bir kez çalışır. Asıl tempo GitHub Actions'tadır.

## GitHub zamanlayıcı

Repo → Settings → Secrets → Actions:

- `SCAN_URL` = `https://senin-siten.vercel.app`
- `CRON_SECRET` = Vercel'deki ile aynı

`Depo tara` işi 15 dakikada bir çalışır. Actions sekmesinden elle de başlatılır.

## Bilgisayarda bakmak

```bash
npm install
npm run check
npm run dev
```

Adres: http://127.0.0.1:3000
