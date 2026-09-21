"use client";

import { useEffect, useRef, useState } from "react";
import type { Status } from "@/lib/types";

const LABELS: Record<string, string> = { evet: "EVET", hayir: "HAYIR", kararsiz: "NET DEĞİL" };

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
  const [password, setPassword] = useState("");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [minDiscount, setMinDiscount] = useState(80);
  const [notifySuspicious, setNotifySuspicious] = useState(false);
  const [chats, setChats] = useState<{ id: string; label: string }[]>([]);
  const [note, setNote] = useState("");
  const [noteOk, setNoteOk] = useState(true);
  const [busy, setBusy] = useState(false);
  const filled = useRef(false);

  useEffect(() => {
    setPassword(sessionStorage.getItem("camasir-admin") || "");
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
    return { "Content-Type": "application/json", "x-admin-password": password };
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

  async function scan() {
    setBusy(true);
    sessionStorage.setItem("camasir-admin", password);
    const response = await fetch("/api/cron/scan", { method: "POST", headers: headers() });
    const data = await response.json();
    setBusy(false);
    if (!response.ok) {
      say(data.error || "Tarama açılmadı", false);
      return;
    }
    say(data.blocked ? "Amazon robot kontrolü gösterdi." : `Sayfa ${data.page}: ${data.seen} ürün.`, !data.blocked);
    await load();
  }

  const fresh = status?.lastScanAt ? Date.now() - new Date(status.lastScanAt).getTime() < 30 * 60 * 1000 : false;

  return (
    <>
      <header>
        <div>
          <p className="brand">ÇAMAŞIRMAKİNESİ</p>
          <h1>Amazon Depo alarmı</h1>
          <p className="lede">
            Amazon'a girince üstteki arama kutusunda Amazon Depo seçili kalır. Arama oradan yapılır,
            sonuçlar sayfa sayfa gezilir. %80 ve üstü Google ile karşılaştırılır. Telegram'a yalnız net ucuz çıkanlar gider.
          </p>
        </div>
        <span className="pill">{fresh ? "az önce tarandı" : "sırada"}</span>
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
              <li>Yönetici şifresini, token'ı yaz, sohbeti bul, kaydet.</li>
            </ol>
            <form onSubmit={save}>
              <label>Yönetici şifresi
                <input type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
              </label>
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
                <button className="ghost" type="button" disabled={busy || !status?.ready} onClick={scan}>
                  {busy ? "Taranıyor" : "Bir sayfa tara"}
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
