"use client";

import { useEffect, useRef, useState } from "react";
import type { Status } from "@/lib/types";

const LABELS: Record<string, string> = { evet: "EVET", hayir: "HAYIR", kararsiz: "NET DEĞİL" };

const CATEGORIES = [
  "Bahçe",
  "Bebek",
  "Bebek Bakım",
  "Bilgisayar",
  "Elektronik",
  "Ev ve Yaşam",
  "Evcil Hayvan Ürünleri",
  "Kitap",
  "Kişisel Bakım ve Kozmetik",
  "Moda",
  "Mutfak",
  "Müzik Enstrümanları ve DJ",
  "Ofis ve Kırtasiye",
  "Otomotiv",
  "Oyuncak",
  "Sağlık ve Kişisel Bakım",
  "Spor ve Outdoor",
  "Video Oyunu ve Konsol",
  "Yapı Market",
];

function tl(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 0 }).format(value);
}

function when(value: string | null | undefined): string {
  if (!value) return "henüz yok";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("tr-TR");
}

function reyonLine(message: string): boolean {
  return message.startsWith("Reyon") || /^(Yeni Gelenler|Günün Fırsatları|Çok Al Az Öde|Outlet)\b/.test(message);
}

function History({ rows }: { rows: { price: number; seenAt: string | null }[] }) {
  if (!rows.length) return <p className="empty">Bu üründe kayıtlı fiyat değişimi yok.</p>;
  const top = Math.max(...rows.map((row) => row.price)) || 1;
  return (
    <ol className="history">
      {rows.map((row, index) => (
        <li key={`${row.seenAt}-${index}`}>
          <span className="bar" style={{ width: `${Math.max(6, Math.round((row.price / top) * 100))}%` }} />
          <b>{tl(row.price)}</b>
          <span>{when(row.seenAt)}</span>
        </li>
      ))}
    </ol>
  );
}

function Photo({ src }: { src: string | null }) {
  if (!src || !src.startsWith("https://")) return <span className="ph" />;
  return <img alt="" src={src} />;
}

export default function Dashboard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [gateReady, setGateReady] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [minDiscount, setMinDiscount] = useState(50);
  const [notifySuspicious, setNotifySuspicious] = useState(false);
  const [chats, setChats] = useState<{ id: string; label: string }[]>([]);
  const [note, setNote] = useState("");
  const [noteOk, setNoteOk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState("Elektronik");
  const [customCategory, setCustomCategory] = useState("");
  const [screen, setScreen] = useState<"depo" | "reyon">("depo");
  const [kararHepsi, setKararHepsi] = useState(false);
  const [history, setHistory] = useState<{ asin: string; rows: { price: number; seenAt: string | null }[] } | null>(null);
  const [lookup, setLookup] = useState("");
  const [looking, setLooking] = useState(false);
  const [offers, setOffers] = useState<{ shop: string; title: string; url: string; price: number }[]>([]);
  const filled = useRef(false);

  useEffect(() => {
    const savedUser = sessionStorage.getItem("camasir-user") || "";
    const savedPassword = sessionStorage.getItem("camasir-admin") || "";
    if (savedUser && savedPassword) {
      setUsername(savedUser);
      setPassword(savedPassword);
      setAuthed(true);
    }
    setGateReady(true);
  }, []);

  async function load() {
    const response = await fetch("/api/status", { cache: "no-store" });
    const data = (await response.json()) as Status;
    setStatus(data);
    if (!filled.current && data.ready) {
      filled.current = true;
      setChatId(data.chatId || "");
      setMinDiscount(data.minDiscount || 50);
      setNotifySuspicious(Boolean(data.notifySuspicious));
    }
  }

  useEffect(() => {
    load().catch(() => setNote("Site durumu okunamadı"));
    const timer = setInterval(() => load().catch(() => undefined), 8000);
    return () => clearInterval(timer);
  }, []);

  function headers(): HeadersInit {
    return { "Content-Type": "application/json", "x-admin-user": username, "x-admin-password": password };
  }

  function say(text: string, ok: boolean) {
    setNote(text);
    setNoteOk(ok);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    sessionStorage.setItem("camasir-admin", password);
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        botToken,
        chatId,
        minDiscount,
        notifySuspicious,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      say(data.error || "Kaydedilemedi", false);
      return;
    }
    setBotToken("");
    setStatus(data);
    say("Ayarlar kaydedildi.", true);
  }

  async function discover() {
    sessionStorage.setItem("camasir-admin", password);
    const response = await fetch("/api/telegram/discover", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ botToken }),
    });
    const data = await response.json();
    if (!response.ok) {
      say(data.error || "Sohbet bulunamadı", false);
      return;
    }
    setChats(data.chats);
    if (data.chats.length === 1) setChatId(data.chats[0].id);
    say("Sohbet bulundu. Kaydetmeyi unutma.", true);
  }

  async function testMessage() {
    sessionStorage.setItem("camasir-admin", password);
    const response = await fetch("/api/telegram/test", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ botToken, chatId }),
    });
    const data = await response.json();
    say(response.ok ? "Deneme mesajı gitti." : data.error || "Gitmedi", response.ok);
  }

  async function scanCategory() {
    const picked = customCategory.trim() || category;
    setBusy(true);
    sessionStorage.setItem("camasir-admin", password);
    const response = await fetch("/api/category", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ category: picked }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) {
      say(data.error || "Sıraya alınamadı", false);
      return;
    }
    say(`"${picked}" sıraya alındı. Sıradaki sayfadan itibaren bu kategori taranacak.`, true);
    await load();
  }

  async function watchAdd(event: React.FormEvent) {
    event.preventDefault();
    sessionStorage.setItem("camasir-admin", password);
    const response = await fetch("/api/watch", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ item: watchInput }),
    });
    const data = await response.json();
    if (!response.ok) {
      say(data.error || "Takibe alınamadı", false);
      return;
    }
    setWatchInput("");
    say(data.query ? `"${data.query}" takibe alındı. %${status?.minDiscount ?? 50} düşünce yazar.` : "Takibe alındı. Eşik kadar düşünce Telegram'a yazar.", true);
    await load();
  }

  async function watchDrop(item: string) {
    sessionStorage.setItem("camasir-admin", password);
    await fetch("/api/watch", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ item, query: item, remove: true }),
    });
    await load();
  }

  async function hideDeal(id: number) {
    sessionStorage.setItem("camasir-admin", password);
    await fetch("/api/alert", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ id }),
    });
    await load();
  }

  async function showHistory(asin: string) {
    if (history?.asin === asin) {
      setHistory(null);
      return;
    }
    sessionStorage.setItem("camasir-admin", password);
    const response = await fetch(`/api/watch?asin=${asin}`, { headers: headers() });
    const data = await response.json();
    if (!response.ok) {
      say(data.error || "Geçmiş okunamadı", false);
      return;
    }
    setHistory({ asin, rows: data.history || [] });
  }

  async function compare(event: React.FormEvent) {
    event.preventDefault();
    const name = lookup.trim();
    if (name.length < 2) {
      say("Ürün adını yaz", false);
      return;
    }
    setLooking(true);
    sessionStorage.setItem("camasir-admin", password);
    const response = await fetch("/api/compare", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name }),
    });
    const data = await response.json();
    setLooking(false);
    if (!response.ok) {
      say(data.error || "Arama açılmadı", false);
      return;
    }
    setOffers(data.offers || []);
    say(data.cheapest ? `En ucuz: ${data.cheapest.shop}` : "Bu isimle fiyat çıkmadı.", Boolean(data.cheapest));
  }

  async function enter(event: React.FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) {
      say(data.error || "Giriş olmadı", false);
      return;
    }
    sessionStorage.setItem("camasir-user", username.trim());
    sessionStorage.setItem("camasir-admin", password);
    setNote("");
    setAuthed(true);
  }

  const fresh = status?.lastScanAt ? Date.now() - new Date(status.lastScanAt).getTime() < 15 * 60 * 1000 : false;

  if (!gateReady) return null;

  if (!authed) {
    return (
      <main className="gate">
        <section className="panel">
          <p className="brand">ÇAMAŞIRMAKİNESİ</p>
          <h1>Giriş</h1>
          <p className="lede">Site içeriği kilitli. Kullanıcı adı ve şifre Vercel ayarındakiyle aynı olmalı.</p>
          <form onSubmit={enter}>
            <label>Kullanıcı adı
              <input value={username} autoComplete="username" onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label>Şifre
              <input type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
            </label>
            <button type="submit">Giriş yap</button>
            <p className="hint" style={{ color: noteOk ? "#0e7a43" : "#c81d25" }}>{note}</p>
          </form>
        </section>
      </main>
    );
  }

  return (
    <>
      <header>
        <div>
          <p className="brand">ÇAMAŞIRMAKİNESİ</p>
          <h1>Amazon Depo alarmı</h1>
          <p className="lede">
            Makine kendi kendine gece gündüz Amazon Depo'yu tarar. Tarayıcıyı açık bırakmana gerek yok.
            İstediğin kategoriyi sağdan seçip sıraya alabilirsin. %{status?.minDiscount ?? 50} ve üstü indirimler piyasayla karşılaştırılır.
            Telegram'a yalnız net ucuz çıkanlar gider.
          </p>
        </div>
        <span className="pill">{fresh ? "tarıyor" : "durdu"}</span>
      </header>

      <nav className="tabs">
        <button type="button" className={screen === "depo" ? "on" : ""} onClick={() => setScreen("depo")}>Depo turu</button>
        <button type="button" className={screen === "reyon" ? "on" : ""} onClick={() => setScreen("reyon")}>Reyonlar</button>
      </nav>

      {status && !status.ready ? <p className="banner">{status.message}</p> : null}

      <section className="stats">
        <div className="stat"><span>Hafıza</span><b>{status?.productCount ?? "—"}</b></div>
        <div className="stat"><span>Net fırsat</span><b>{status?.dealCount ?? "—"}</b></div>
        <div className="stat"><span>Sırada bekleyen</span><b>{status?.pendingCount ?? "—"}</b></div>
        <div className="stat"><span>{status?.search ?? "Amazon Depo"}</span><b>sayfa {status?.page ?? "—"}</b></div>
        <div className="stat"><span>Son tarama</span><b style={{ fontSize: 16 }}>{when(status?.lastScanAt)}</b></div>
      </section>

      {screen === "depo" ? <><section className="panel lookup">
        <h2>En ucuz nerede</h2>
        <p className="hint">Ürün adını yaz. Depo taramasından ayrıdır. Basınca Türkiye’de satış yapan sitelere bakar, en ucuzu üste gelir.</p>
        <form onSubmit={compare}>
          <label>Ürün adı
            <input type="text" value={lookup} placeholder="örnek: S-link Lightning kablo 20 cm" onChange={(event) => setLookup(event.target.value)} />
          </label>
          <button type="submit" disabled={looking}>{looking ? "Bakılıyor" : "En ucuzu bul"}</button>
        </form>
        {offers.length ? (
          <ol className="offers">
            {offers.map((offer, index) => (
              <li key={`${offer.url}-${offer.price}`} className={index === 0 ? "cheapest" : ""}>
                <b>{index === 0 ? "En ucuz · " : ""}{offer.shop}</b>
                <span className="price">{tl(offer.price)}</span>
                <a href={offer.url} target="_blank" rel="noopener noreferrer">{offer.title}</a>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <main>
        <section className="panel">
          <div className="panel-head">
            <h2>Kararlar</h2>
            <p>10 bin TL üstünde %{20}, altında %{status?.minDiscount ?? 50}. Varsayılan yalnız EVET.</p>
            <button className="ghost" type="button" onClick={() => setKararHepsi(!kararHepsi)}>
              {kararHepsi ? "Yalnız EVET göster" : "HAYIR ve NET DEĞİL de göster"}
            </button>
          </div>
          {(() => {
            const rows = (status?.alerts ?? []).filter((deal) => kararHepsi || deal.verdict === "evet");
            if (!rows.length) {
              return <p className="empty">{kararHepsi ? `Henüz eşik geçen ürün yok. Sırada ${status?.pendingCount ?? 0} ürün var.` : "Henüz EVET yok. Diğer kararlar için üstteki düğmeye bas."}</p>;
            }
            return rows.map((deal) => (
            <article className="deal" key={deal.id}>
              <Photo src={deal.image} />
              <div>
                <div className="deal-top">
                  <span className={`badge ${deal.verdict}`}>{LABELS[deal.verdict] || deal.verdict}</span>
                  <button className="ghost close" type="button" onClick={() => hideDeal(deal.id)} aria-label="Kapat">×</button>
                </div>
                <span className="price">%{Math.round(deal.discount)} · {tl(deal.price)}</span>
                {deal.listPrice ? <span className="old">{tl(deal.listPrice)}</span> : null}
                <div className="title">{deal.title}</div>
                <p className="detail">{deal.detail}</p>
                <a href={deal.url} target="_blank" rel="noopener noreferrer">Amazon'da aç</a>
                <div className="row-buttons">
                  <button className="ghost" type="button" onClick={() => showHistory(deal.asin)}>Fiyat geçmişi</button>
                  <button className="ghost" type="button" onClick={() => { setWatchInput(deal.asin); say("Ürün kodu yazıldı, aşağıdan Takibe al'a bas.", true); }}>Takibe al</button>
                </div>
                {history?.asin === deal.asin ? <History rows={history.rows} /> : null}
              </div>
            </article>
            ));
          })()}
        </section>

        <aside>
          <section className="panel">
            <h2>Telegram</h2>
            <ol className="steps">
              <li>@BotFather'a <b>/newbot</b> yaz, token'ı al.</li>
              <li>Kendi botuna <b>/start</b> gönder.</li>
              <li>Token'ı yaz, sohbeti bul, kaydet.</li>
            </ol>
            <form onSubmit={save}>
              <label>Bot token
                <input type="password" value={botToken} autoComplete="off" placeholder="123456:ABC..." onChange={(event) => setBotToken(event.target.value)} />
              </label>
              <p className="hint">{status?.hasToken ? `Kayıtlı token: ${status.tokenHint}` : "Token henüz yok."}</p>
              <label>Sohbet numarası
                <input value={chatId} inputMode="numeric" onChange={(event) => setChatId(event.target.value)} />
              </label>
              <div className="chats">
                {chats.map((chat) => (
                  <button className="ghost" type="button" key={chat.id} onClick={() => setChatId(chat.id)}>
                    {chat.label} · {chat.id}
                  </button>
                ))}
              </div>
              <label>Kategori
                <select value={category} onChange={(event) => setCategory(event.target.value)}>
                  {CATEGORIES.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
              <label>Kendi kategorin
                <input type="text" value={customCategory} placeholder="örnek: kulaklık" onChange={(event) => setCustomCategory(event.target.value)} />
              </label>
              <label>İndirim eşiği %
                <input type="number" min={20} max={95} value={minDiscount} onChange={(event) => setMinDiscount(Number(event.target.value))} />
              </label>
              <label className="check">
                <input type="checkbox" checked={notifySuspicious} onChange={(event) => setNotifySuspicious(event.target.checked)} />
                Hayır çıkanları da Telegram'a yaz
              </label>
              <div className="buttons">
                <button type="submit">Kaydet</button>
                <button className="ghost" type="button" onClick={discover}>Sohbeti bul</button>
                <button className="ghost" type="button" onClick={testMessage}>Deneme mesajı</button>
                <button className="ghost" type="button" disabled={busy || !status?.ready} onClick={scanCategory}>
                  {busy ? "Aranıyor" : "Bu kategoride ara"}
                </button>
              </div>
              <p className="hint" style={{ color: noteOk ? "#0e7a43" : "#c81d25" }}>{note}</p>
            </form>
          </section>
          <section className="panel">
            <h2>Son görülenler</h2>
            {status?.recent.length ? status.recent.map((item) => (
              <article className="recent-item" key={item.asin}>
                <Photo src={item.image} />
                <div>
                  <div className="title">{item.title}</div>
                  <span className="price">{tl(item.price)}</span>
                  {item.listPrice ? <span className="old">{tl(item.listPrice)}</span> : null}
                </div>
              </article>
            )) : <p className="empty">Henüz ürün yok.</p>}
          </section>
        </aside>
      </main>
      <section className="panel log-panel">
        <div className="panel-head">
          <h2>Takip listem</h2>
          <p>Ürün adını yaz. 10 bin üstü %20, altı %{status?.minDiscount ?? 50} düşünce yazar. Turda üç isim birden aranır.</p>
        </div>
        <form onSubmit={watchAdd} className="watch-form">
          <label>Ürün adı veya link
            <input type="text" value={watchInput} placeholder="örnek: iPhone 17 Pro Max" onChange={(event) => setWatchInput(event.target.value)} />
          </label>
          <button type="submit">Takibe al</button>
        </form>
        {status?.watch.length ? (
          <div className="watch-grid">
            {status.watch.map((item) => (
              <article className="watch-chip" key={item.query || item.asin}>
                <div className="title">{item.title || item.query || item.asin}</div>
                <span className="price">{item.price ? tl(item.price) : "bekleniyor"}</span>
                <button className="ghost" type="button" onClick={() => watchDrop(item.query || item.asin)}>Çıkar</button>
              </article>
            ))}
          </div>
        ) : <p className="empty">Takip listen boş.</p>}
      </section>
      </> : null}

      {screen === "reyon" ? (
        <section className="panel log-panel">
          <h2>Reyonlar</h2>
          <p className="hint">Kategori turundan ayrı çalışır. Yeni Gelenler, Depo'ya yeni düşen ürünleri sırayla okur. Diğer üçü Depo sayfasının içinden açılır, aşağı inildikçe yeni ürünler okunur.</p>
          <div className="reyon-list">
            {(status?.aisles ?? []).map((row) => (
              <div key={row.label} className={status?.aisle === row.label ? "now" : ""}>
                <b>{row.label}</b>
                <span>sayfa {row.page} · {row.count} ürün</span>
              </div>
            ))}
          </div>

          <h3 className="reyon-head">Reyondan çıkan fırsatlar</h3>
          {status?.aisleAlerts.length ? status.aisleAlerts.map((deal) => (
            <article className="deal" key={`reyon-${deal.id}`}>
              <Photo src={deal.image} />
              <div>
                <div className="deal-top">
                  <span className={`badge ${deal.verdict}`}>{LABELS[deal.verdict] || deal.verdict}</span>
                  <button className="ghost close" type="button" onClick={() => hideDeal(deal.id)} aria-label="Kapat">×</button>
                </div>
                <span className="price">%{Math.round(deal.discount)} · {tl(deal.price)}</span>
                {deal.listPrice ? <span className="old">{tl(deal.listPrice)}</span> : null}
                <div className="title">{deal.title}</div>
                <p className="detail">{deal.detail}</p>
                <a href={deal.url} target="_blank" rel="noopener noreferrer">Amazon'da aç</a>
              </div>
            </article>
          )) : <p className="empty">Reyonlarda %{status?.minDiscount ?? 80} eşiğini geçen ürün çıkmadı. Çıkarsa buraya düşer ve Telegram'a gider.</p>}

          <h3 className="reyon-head">Reyonda görülenler</h3>
          {status?.aisleItems.length ? (
            <div className="reyon-items">
              {status.aisleItems.map((item) => (
                <article className="recent-item" key={`${item.aisle}-${item.asin}`}>
                  <Photo src={item.image} />
                  <div>
                    <div className="title">{item.title}</div>
                    <span className="price">{tl(item.price)}</span>
                    {item.listPrice ? <span className="old">{tl(item.listPrice)}</span> : null}
                    {item.discount > 0 ? <span className="badge evet">%{item.discount}</span> : null}
                    <a href={item.url} target="_blank" rel="noopener noreferrer">{item.aisle}</a>
                  </div>
                </article>
              ))}
            </div>
          ) : <p className="empty">Reyonda ürün görülmedi.</p>}
          <ol className="log">
            {(status?.logs ?? []).filter((line) => reyonLine(line.message)).map((line, index) => (
              <li key={`${line.createdAt}-${index}`}>{when(line.createdAt)} — {line.message.replace(/^Reyon · /, "")}</li>
            ))}
          </ol>
          {(status?.logs ?? []).some((line) => reyonLine(line.message)) ? null : <p className="empty">Reyon günlüğü bir sonraki taramada dolacak.</p>}
        </section>
      ) : (
        <section className="panel log-panel">
          <h2>Günlük</h2>
          <ol className="log">
            {status?.lastError ? <li>{status.lastError}</li> : null}
            {(status?.logs ?? []).filter((line) => !reyonLine(line.message)).map((line, index) => (
              <li key={`${line.createdAt}-${index}`}>{when(line.createdAt)} — {line.message}</li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
