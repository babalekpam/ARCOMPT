"use client";

import Link from "next/link";
import { useState } from "react";
import { BrandLockup } from "@/components/brand/BrandMark";
import { LocaleSwitcher } from "@/components/shell/LocaleSwitcher";
import type { Locale } from "@/lib/i18n";
import { getLandingCopy } from "./content";
import styles from "./landing.module.css";
import DashboardVisual from "./DashboardVisual";

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

export function LandingPage({ locale }: { locale: Locale }) {
  const copy = getLandingCopy(locale);
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <main className={styles.page}>
      <header className={styles.shell}>
        <nav className={styles.nav} aria-label={copy.nav.navigation}>
          <Link href="/" aria-label={copy.nav.home}><BrandLockup size="md" /></Link>
          <div className={styles.navLinks}>
            <a href="#platform">{copy.nav.product}</a>
            <a href="#method">{copy.nav.method}</a>
            <a href="#firms">{copy.nav.forFirms}</a>
          </div>
          <div className={styles.navActions}>
            <LocaleSwitcher compact />
            <Link className={styles.signIn} href="/login">{copy.nav.signIn}</Link>
            <Link className={styles.signUp} href="/sign-up">{copy.nav.signUp}</Link>
            <button className={styles.menuButton} type="button" aria-expanded={menuOpen} aria-controls="landing-mobile-nav" onClick={() => setMenuOpen((open) => !open)}>{copy.nav.menu}</button>
          </div>
        </nav>
        {menuOpen && <div id="landing-mobile-nav" className={styles.mobileNav}><a href="#platform" onClick={() => setMenuOpen(false)}>{copy.nav.product}</a><a href="#method" onClick={() => setMenuOpen(false)}>{copy.nav.method}</a><a href="#firms" onClick={() => setMenuOpen(false)}>{copy.nav.forFirms}</a><Link href="/login" onClick={() => setMenuOpen(false)}>{copy.nav.signIn}</Link><Link href="/sign-up" onClick={() => setMenuOpen(false)}>{copy.nav.signUp}</Link></div>}
      </header>

      <section className={styles.hero}>
        <div className={`${styles.shell} ${styles.heroGrid}`}>
          <div className={styles.reveal}>
            <p className={styles.eyebrow}>{copy.hero.eyebrow}</p>
            <h1>{copy.hero.title}</h1>
            <p className={styles.heroBody}>{copy.hero.body}</p>
            <div className={styles.actions}>
              <Link className={styles.primary} href="/sign-up">{copy.hero.primary} <span style={{ marginLeft: 10 }}><Arrow /></span></Link>
              <a className={styles.secondary} href="#method">{copy.hero.secondary}</a>
            </div>
            <p className={styles.heroNote}>{copy.hero.note}</p>
          </div>
          <div className={`${styles.ledger} ${styles.reveal} ${styles.delay}`} aria-hidden="true">
            <div className={styles.ledgerTop}><span>{copy.workspace.labels.journal}</span><span className={styles.ledgerDot}><i /><i /><i /></span></div>
            <div className={styles.ledgerBody}>
              <p className={styles.ledgerTitle}>{copy.workspace.labels.balance}</p>
              <p className={styles.ledgerAmount}>SYSCOHADA</p>
              <span className={styles.ledgerCaption}>{copy.workspace.labels.review}</span>
              <div className={styles.bars}>{[1, 2, 3, 4, 5, 6, 7].map((bar) => <i className={styles.bar} key={bar} />)}</div>
              <div className={styles.ledgerFoot}><span>ARCOMPT</span><span>{copy.workspace.labels.review}</span></div>
            </div>
          </div>
        </div>
      <div className={styles.shell}><DashboardVisual /></div>
      </section>

      <section className={styles.proof}><div className={`${styles.shell} ${styles.proofRow}`}><span className={styles.proofLabel}>{copy.proof.label}</span><div className={styles.proofItems}>{copy.proof.items.map((item) => <span key={item}>{item}</span>)}</div></div></section>

      <section className={`${styles.section} ${styles.shell}`}><div className={styles.principle}><div><p className={styles.kicker}>{copy.principle.kicker}</p></div><div><h2>{copy.principle.title}</h2><p className={styles.bodyCopy}>{copy.principle.body}</p><p className={styles.asideQuote}>{copy.principle.aside}</p></div></div></section>

       <section id="platform" className={`${styles.section} ${styles.workspaceSection}`}><div className={`${styles.shell} ${styles.workspaceGrid}`}><div><p className={styles.kicker}>{copy.workspace.kicker}</p><h2>{copy.workspace.title}</h2><p className={styles.bodyCopy}>{copy.workspace.body}</p></div><div className={styles.screen} aria-hidden="true"><div className={styles.screenHead}><span>ARCOMPT / SYSCOHADA</span><span>OHADA</span></div><div className={styles.screenGrid}><div className={styles.screenCell}><span>{copy.workspace.labels.journal}</span><strong>01</strong><span>{copy.workspace.labels.pending}</span></div><div className={styles.screenCell}><span>{copy.workspace.labels.balance}</span><strong>02</strong><span>{copy.workspace.labels.review}</span></div><div className={styles.screenCell}><span>{copy.modules.items[1].title}</span><strong>03</strong><span className={styles.status}>{copy.method.steps[0].title}</span></div><div className={styles.screenCell}><span>{copy.modules.items[2].title}</span><strong>04</strong><span className={styles.status}>{copy.method.steps[2].title}</span></div></div></div></div></section>

      <section className={`${styles.section} ${styles.shell}`}><div className={styles.moduleIntro}><div><p className={styles.kicker}>{copy.modules.kicker}</p></div><div><h2>{copy.modules.title}</h2><p className={styles.bodyCopy}>{copy.modules.body}</p></div></div><div className={styles.moduleList}>{copy.modules.items.map((item, index) => <article className={styles.moduleItem} key={item.title}><span className={styles.moduleNo}>0{index + 1}</span><h3>{item.title}</h3><p>{item.body}</p></article>)}</div></section>

      <section id="method" className={`${styles.section} ${styles.methodSection}`}><div className={styles.shell}><div className={styles.methodHead}><div><p className={styles.kicker}>{copy.method.kicker}</p><h2>{copy.method.title}</h2></div><p className={styles.bodyCopy}>{copy.method.body}</p></div><div className={styles.steps}>{copy.method.steps.map((step) => <article className={styles.step} key={step.no}><span className={styles.stepNo}>{step.no}</span><h3>{step.title}</h3><p>{step.body}</p></article>)}</div></div></section>

      <section id="firms" className={`${styles.section} ${styles.shell}`}><div className={styles.firmsGrid}><div><p className={styles.kicker}>{copy.firms.kicker}</p><h2>{copy.firms.title}</h2><p className={styles.bodyCopy}>{copy.firms.body}</p><Link className={`${styles.primary}`} href="/sign-up" style={{ marginTop: 30 }}>{copy.firms.cta}<span style={{ marginLeft: 10 }}><Arrow /></span></Link></div><ul className={styles.checkList}>{copy.firms.items.map((item) => <li key={item}>{item}</li>)}</ul></div></section>

      <section className={`${styles.section} ${styles.guardrailSection}`}><div className={`${styles.shell} ${styles.guardrailGrid}`}><div><p className={styles.kicker}>{copy.guardrails.kicker}</p><h2>{copy.guardrails.title}</h2><p className={styles.bodyCopy}>{copy.guardrails.body}</p></div><ul className={styles.guardrailList}>{copy.guardrails.items.map((item) => <li key={item}>{item}</li>)}</ul></div></section>

      <section className={styles.closeSection}><div className={styles.shell}><p className={styles.kicker}>{copy.nav.product}</p><h2>{copy.close.title}</h2><p className={styles.bodyCopy}>{copy.close.body}</p><div className={styles.actions} style={{ marginTop: 29 }}><Link className={styles.primary} href="/sign-up">{copy.close.primary}<span style={{ marginLeft: 10 }}><Arrow /></span></Link><a className={styles.secondary} href="mailto:info@arcompt.com">{copy.close.secondary}</a></div></div></section>

      <footer className={`${styles.footer} ${styles.shell}`}><div className={styles.footerRow}><span>{copy.footer.line}</span><span><a href="#platform">{copy.nav.product}</a><a href="#method">{copy.nav.method}</a><a href="mailto:info@arcompt.com">{copy.nav.contact}</a></span></div><div className={styles.footerBottom}><span>{copy.footer.built}</span><span>{copy.footer.legal}</span></div></footer>
    </main>
  );
}

export default LandingPage;