// Realistische Beispiel-Mails für die Erkennung von Bounces, Abwesenheiten und Antworten.

const crlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

export function gmailBounce(to: string, originalMessageId: string): string {
  return crlf(`Delivered-To: max@absender.de
Return-Path: <>
From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: max@absender.de
Subject: Delivery Status Notification (Failure)
Date: Tue, 4 Mar 2025 10:21:00 +0100
Message-ID: <bounce-1@mx.google.com>
X-Failed-Recipients: ${to}
Auto-Submitted: auto-replied
MIME-Version: 1.0
Content-Type: multipart/report; boundary="grenze1"; report-type=delivery-status

--grenze1
Content-Type: text/plain; charset="UTF-8"

Address not found

Your message wasn't delivered to ${to} because the address couldn't be found, or is unable to receive mail.

--grenze1
Content-Type: message/delivery-status

Reporting-MTA: dns; googlemail.com

Final-Recipient: rfc822; ${to}
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.

--grenze1
Content-Type: text/rfc822-headers

From: Max Mustermann <max@absender.de>
To: ${to}
Subject: Frage zu Becker GmbH
Message-ID: ${originalMessageId}

--grenze1--
`);
}

export function outlookNdr(to: string): string {
  return crlf(`From: postmaster@becker-logistik.de
To: max@absender.de
Subject: Unzustellbar: Frage zu Becker GmbH
Date: Tue, 4 Mar 2025 10:25:00 +0100
Message-ID: <ndr-2@becker-logistik.de>
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status; boundary="b2"

--b2
Content-Type: text/plain; charset="utf-8"

Die Nachricht konnte nicht zugestellt werden. Der Empfänger ${to} existiert nicht.

--b2
Content-Type: message/delivery-status

Final-Recipient: rfc822;${to}
Action: failed
Status: 5.1.10
Diagnostic-Code: smtp;550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup

--b2--
`);
}

export function delayNotice(to: string): string {
  return crlf(`From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: max@absender.de
Subject: Delivery Status Notification (Delay)
Date: Tue, 4 Mar 2025 11:00:00 +0100
Message-ID: <delay-3@mx.google.com>
X-Failed-Recipients: ${to}
MIME-Version: 1.0
Content-Type: multipart/report; boundary="b3"; report-type=delivery-status

--b3
Content-Type: text/plain

Delivery incomplete. There was a temporary problem delivering your message to ${to}. Gmail will retry for 46 more hours.

--b3
Content-Type: message/delivery-status

Final-Recipient: rfc822; ${to}
Action: delayed
Status: 4.4.7

--b3--
`);
}

export function outlookOutOfOffice(from: string, inReplyTo: string): string {
  return crlf(`From: Julia Becker <${from}>
To: Max Mustermann <max@absender.de>
Subject: Automatische Antwort: Frage zu Becker GmbH
Date: Tue, 4 Mar 2025 10:30:00 +0100
Message-ID: <ooo-4@becker-logistik.de>
In-Reply-To: ${inReplyTo}
Auto-Submitted: auto-generated
X-Auto-Response-Suppress: All
Content-Type: text/plain; charset="utf-8"

Vielen Dank für Ihre Nachricht. Ich bin bis zum 14.03.2025 nicht im Büro und habe keinen Zugriff auf meine E-Mails.
In dringenden Fällen wenden Sie sich bitte an info@becker-logistik.de.
`);
}

export function gmailVacation(from: string, inReplyTo: string): string {
  return crlf(`From: Tom Werner <${from}>
To: max@absender.de
Subject: Re: Frage zu Werk AG
Date: Tue, 4 Mar 2025 10:31:00 +0100
Message-ID: <vac-5@werk.de>
In-Reply-To: ${inReplyTo}
References: ${inReplyTo}
Auto-Submitted: auto-replied
Precedence: bulk
Content-Type: text/plain; charset="utf-8"

Hallo, ich bin im Urlaub und ab dem 10. März wieder erreichbar.
`);
}

export function humanReply(from: string, inReplyTo: string): string {
  return crlf(`From: Julia Becker <${from}>
To: Max Mustermann <max@absender.de>
Subject: Re: Frage zu Becker GmbH
Date: Tue, 4 Mar 2025 14:02:00 +0100
Message-ID: <reply-6@becker-logistik.de>
In-Reply-To: ${inReplyTo}
References: ${inReplyTo}
Content-Type: text/plain; charset="utf-8"

Hallo Herr Mustermann,

klingt interessant. Rufen Sie mich gern am Donnerstag an: 0561 123456.

Viele Grüße
Julia Becker

Am Di., 4. März 2025 um 09:20 Uhr schrieb Max Mustermann <max@absender.de>:
> Guten Tag Frau Becker,
>
> kurze Frage zu Becker GmbH.
>
> Kein Interesse? Eine kurze Antwort genügt, dann melde ich mich nicht mehr.
`);
}

export function unsubscribeReply(from: string, inReplyTo: string): string {
  return crlf(`From: Anna Nord <${from}>
To: max@absender.de
Subject: AW: Frage zu Nord KG
Date: Tue, 4 Mar 2025 15:00:00 +0100
Message-ID: <unsub-7@nord.de>
In-Reply-To: ${inReplyTo}
Content-Type: text/plain; charset="utf-8"

Bitte nehmen Sie mich aus Ihrem Verteiler.

-----Ursprüngliche Nachricht-----
Von: Max Mustermann <max@absender.de>
Gesendet: Dienstag, 4. März 2025 09:40
`);
}

export function gmailUnsubscribeButton(from: string): string {
  return crlf(`From: ${from}
To: max@absender.de
Subject: Abmelden
Date: Tue, 4 Mar 2025 16:00:00 +0100
Message-ID: <listunsub-8@mail.gmail.com>
Content-Type: text/plain; charset="utf-8"

This message was automatically generated by Gmail.
`);
}

export function colleagueReply(inReplyTo: string): string {
  return crlf(`From: Peter Kollege <peter@becker-logistik.de>
To: max@absender.de
Subject: Re: Frage zu Becker GmbH
Date: Tue, 4 Mar 2025 16:30:00 +0100
Message-ID: <colleague-9@becker-logistik.de>
In-Reply-To: ${inReplyTo}
Content-Type: text/plain; charset="utf-8"

Hallo, Frau Becker hat mir Ihre Mail weitergeleitet. Ich bin der richtige Ansprechpartner.
`);
}

export function unrelatedMail(): string {
  return crlf(`From: Newsletter <news@shop.example>
To: max@absender.de
Subject: Unsere Angebote der Woche
Date: Tue, 4 Mar 2025 17:00:00 +0100
Message-ID: <news-10@shop.example>
Content-Type: text/plain; charset="utf-8"

Neue Angebote!
`);
}
