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
  const [minDiscount, setMinDiscount] = useState(80);
  const [notifySuspicious, setNotifySuspicious] = useState(false);
  const [chats, setChats] = useState<{ id: string; label: string }[]>([]);
  const [note, setNote] = useState("");
  const [noteOk, setNoteOk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState("Elektronik");
  const [customCategory, setCustomCategory] = useState("");
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
      setMinDiscount(data.minDiscount || 80);
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
    const response = await fetch("/api/cron/scan", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ category: picked }),
    });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) {
      say(data.error || "Tarama açılmadı", false);
      return;
    }
    say(data.blocked ? "Amazon robot kontrolü gösterdi." : `"${picked}" arandı: ${data.seen} ürün.`, !data.blocked);
    await load();
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
            İstediğin kategoriyi sağdan seçip ayrıca da aratabilirsin. %80 ve üstü Google ile karşılaştırılır.
            Telegram'a yalnız net ucuz çıkanlar gider.
          </p>
        </div>
        <span className="pill">{fresh ? "tarıyor" : "durdu"}</span>
      </header>

      {status && !status.ready ? <p className="banner">{status.message}</p> : null}

      <section className="stats">
        <div className="stat"><span>Hafıza</span><b>{status?.productCount ?? "—"}</b></div>
        <div className="stat"><span>Net fırsat</span><b>{status?.dealCount ?? "—"}</b></div>
        <div className="stat"><span>{status?.search ?? "Amazon Depo"}</span><b>sayfa {status?.page ?? "—"}</b></div>
        <div className="stat"><span>Son tarama</span><b style={{ fontSize: 16 }}>{when(status?.lastScanAt)}</b></div>
      </section>

      <main>
        <section className="panel">
          <div className="panel-head">
            <h2>Kararlar</h2>
            <p>%80 eşiğini geçen ürünler. EVET = piyasadan da ucuz.</p>
          </div>
          {status?.alerts.length ? status.alerts.map((deal) => (
            <article className="deal" key={deal.id}>
              <Photo src={deal.image} />
              <div>
                <span className={`badge ${deal.verdict}`}>{LABELS[deal.verdict] || deal.verdict}</span>
                <span className="price">%{Math.round(deal.discount)} · {tl(deal.price)}</span>
                {deal.listPrice ? <span className="old">{tl(deal.listPrice)}</span> : null}
                <div className="title">{deal.title}</div>
                <p className="detail">{deal.detail}</p>
                <a href={deal.url} target="_blank" rel="noopener noreferrer">Amazon'da aç</a>
              </div>
            </article>
          )) : <p className="empty">Henüz %{status?.minDiscount ?? 80} eşiğini geçen ürün yok.</p>}
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
                <input type="number" min={40} max={95} value={minDiscount} onChange={(event) => setMinDiscount(Number(event.target.value))} />
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
        <h2>Günlük</h2>
        <ol className="log">
          {status?.lastError ? <li>{status.lastError}</li> : null}
          {status?.logs.map((line, index) => (
            <li key={`${line.createdAt}-${index}`}>{when(line.createdAt)} — {line.message}</li>
          ))}
        </ol>
      </section>
    </>
  );
}
