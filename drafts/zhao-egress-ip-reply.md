To: Zhao (VPS Customer)
From: EdgeIQ Labs Support <support@edgeiqlabs.com>
Subject: Re: Question about egress IP 100.33.233.11
Date: 2026-09-20

---

Hi Zhao,

Good question. The egress IP `100.33.233.11` is **fixed/static** — it does not rotate or change over time. It's the dedicated public IP of the infrastructure your VPS runs on.

The reason some IP databases classify it as a "shared proxy pool" is because multiple services run behind our reverse proxy (Traefik) on this single IP. Automated IP-reputation databases often categorize hosting-provider IPs with mixed traffic this way, but it is not a third-party proxy rotation service.

To be explicit:
- **The IP is sticky.** Your egress traffic will always originate from this address.
- **There is no rotation interval or trigger.** The IP only changes if we perform scheduled infrastructure maintenance and notify you in advance.

If you're running into issues with specific services blocking or rate-limiting this IP due to its database classification, let us know and we can look into solutions.

Best,
EdgeIQ Labs Support
