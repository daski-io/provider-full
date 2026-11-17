# Service taxonomy

Daski discovery uses three separate dimensions:

- `categoryFamily`: broad marketplace placement;
- `serviceType`: a controlled, specific product type coordinated with Daski;
- `jurisdictions`: where the offering can be fulfilled.

Do not encode one dimension into another.

## Category families

The provider contract currently accepts:

| Family | Typical scope |
| --- | --- |
| `business-formation` | Company creation and corporate lifecycle |
| `legal-ip` | Legal and intellectual-property services |
| `compliance` | Screening, reporting, audit, and regulatory work |
| `finance` | Accounting, tax, treasury, insurance, and payments support |
| `domains-web` | Web presence, hosting, certificates, and naming |
| `communications` | Email, phone, messaging, and communication channels |
| `compute-ai` | Compute, models, inference, and automation |
| `data` | Data acquisition, enrichment, transformation, and analysis |
| `software-dev` | Software development, testing, and maintenance |
| `design-creative` | Design, media, and creative production |
| `marketing-growth` | Marketing, advertising, audience, and growth |
| `sales-support` | Sales operations and customer support |
| `human-talent` | Recruiting, staffing, training, and expert labor |
| `operations-admin` | Back-office and administrative operations |
| `logistics-physical` | Shipping, warehousing, field, and physical services |
| `other` | Offerings that do not fit an approved family |

Choose the narrowest accurate family. Do not add a new literal only in your
fork; it will not be understood by marketplace discovery.

The dummy service uses `other` because it is a reference, not a real
marketplace product.

## Service type

`serviceType` is a lowercase kebab-case controlled value for the actual
product. It is more specific than `categoryFamily` and should remain stable
across copy edits.

Coordinate new values with Daski onboarding before launch. A locally invented
value may compile but fail marketplace review or discovery expectations.

### Controlled service types

Pick the type that names your product from your family's list. When none
fits, use the family's own fallback, `<family>-other` (`other` in the family
`other`), and coordinate a new value with Daski. The ids below are stable;
the labels are what the marketplace shows. The registry checks only the
form of a value, so the list is a convention discovery relies on, not a
compile-time check.

#### `business-formation`

| Id | Label |
| --- | --- |
| `entity-formation` | Entity formation |
| `registered-agent` | Registered agent |
| `ein-tax-id` | Tax ID registration |
| `annual-report-filing` | Annual report filing |
| `company-amendment` | Company amendment |
| `foreign-qualification` | Foreign qualification |
| `business-license` | Business license |
| `company-dissolution` | Company dissolution |
| `virtual-office` | Virtual office |
| `business-formation-other` | Other |

#### `legal-ip`

| Id | Label |
| --- | --- |
| `contract-drafting` | Contract drafting |
| `contract-review` | Contract review |
| `trademark-search` | Trademark search |
| `trademark-filing` | Trademark filing |
| `patent-search` | Patent search |
| `patent-filing` | Patent filing |
| `copyright-registration` | Copyright registration |
| `legal-document-preparation` | Legal document preparation |
| `legal-research` | Legal research |
| `notarization` | Notarization |
| `legal-ip-other` | Other |

#### `compliance`

| Id | Label |
| --- | --- |
| `kyc-verification` | Identity verification |
| `kyb-verification` | Business verification |
| `sanctions-screening` | Sanctions screening |
| `background-check` | Background check |
| `regulatory-filing` | Regulatory filing |
| `privacy-compliance` | Privacy compliance |
| `security-audit` | Security audit |
| `accessibility-audit` | Accessibility audit |
| `compliance-other` | Other |

#### `finance`

| Id | Label |
| --- | --- |
| `bookkeeping` | Bookkeeping |
| `tax-preparation` | Tax preparation |
| `sales-tax-filing` | Sales tax filing |
| `payroll` | Payroll |
| `invoicing-collections` | Invoicing and collections |
| `financial-statements` | Financial statements |
| `financial-modeling` | Financial modeling |
| `audit-assurance` | Audit and assurance |
| `insurance-quote` | Insurance quote |
| `finance-other` | Other |

#### `domains-web`

| Id | Label |
| --- | --- |
| `domain-management` | Domain management |
| `server-hosting` | Server hosting |
| `web-hosting` | Web hosting |
| `ssl-certificate` | SSL certificate |
| `website-build` | Website build |
| `website-maintenance` | Website maintenance |
| `cdn-setup` | CDN setup |
| `domains-web-other` | Other |

#### `communications`

| Id | Label |
| --- | --- |
| `agent-mailbox` | Agent mailbox |
| `email-hosting` | Email hosting |
| `phone-number` | Phone number |
| `sms-messaging` | SMS messaging |
| `transactional-email` | Transactional email |
| `physical-mail` | Physical mail |
| `fax` | Fax |
| `translation` | Translation |
| `transcription` | Transcription |
| `communications-other` | Other |

#### `compute-ai`

| Id | Label |
| --- | --- |
| `ai-inference` | AI inference |
| `gpu-compute` | GPU compute |
| `model-fine-tuning` | Model fine-tuning |
| `ai-agent-build` | AI agent build |
| `data-labeling` | Data labeling |
| `ai-evaluation` | AI evaluation |
| `workflow-automation` | Workflow automation |
| `compute-ai-other` | Other |

#### `data`

| Id | Label |
| --- | --- |
| `web-research` | Web research |
| `data-scraping` | Data scraping |
| `lead-list` | Lead list |
| `data-enrichment` | Data enrichment |
| `data-cleaning` | Data cleaning |
| `data-analysis` | Data analysis |
| `dataset` | Dataset |
| `market-research` | Market research |
| `data-other` | Other |

#### `software-dev`

| Id | Label |
| --- | --- |
| `feature-development` | Feature development |
| `bug-fix` | Bug fix |
| `code-review` | Code review |
| `api-integration` | API integration |
| `mobile-app` | Mobile app |
| `smart-contract` | Smart contract |
| `smart-contract-audit` | Smart contract audit |
| `qa-testing` | QA testing |
| `devops` | DevOps |
| `software-dev-other` | Other |

#### `design-creative`

| Id | Label |
| --- | --- |
| `logo-design` | Logo design |
| `brand-identity` | Brand identity |
| `graphic-design` | Graphic design |
| `ui-ux-design` | UI/UX design |
| `illustration` | Illustration |
| `photography` | Photography |
| `video-production` | Video production |
| `animation` | Animation |
| `copywriting` | Copywriting |
| `content-writing` | Content writing |
| `voice-over` | Voice-over |
| `design-creative-other` | Other |

#### `marketing-growth`

| Id | Label |
| --- | --- |
| `seo` | SEO |
| `paid-ads` | Paid ads |
| `social-media-management` | Social media management |
| `email-marketing` | Email marketing |
| `public-relations` | Public relations |
| `media-outreach` | Media outreach |
| `influencer-marketing` | Influencer marketing |
| `content-marketing` | Content marketing |
| `app-store-optimization` | App store optimization |
| `reviews-reputation` | Reviews and reputation |
| `marketing-growth-other` | Other |

#### `sales-support`

| Id | Label |
| --- | --- |
| `lead-generation` | Lead generation |
| `appointment-setting` | Appointment setting |
| `outbound-outreach` | Outbound outreach |
| `crm-setup` | CRM setup |
| `customer-support` | Customer support |
| `call-answering` | Call answering |
| `sales-support-other` | Other |

#### `human-talent`

| Id | Label |
| --- | --- |
| `recruiting` | Recruiting |
| `virtual-assistant` | Virtual assistant |
| `expert-consultation` | Expert consultation |
| `tutoring-training` | Tutoring and training |
| `freelance-staffing` | Freelance staffing |
| `human-talent-other` | Other |

#### `operations-admin`

| Id | Label |
| --- | --- |
| `data-entry` | Data entry |
| `document-processing` | Document processing |
| `scheduling` | Scheduling |
| `procurement` | Procurement |
| `vendor-management` | Vendor management |
| `research-assistance` | Research assistance |
| `operations-admin-other` | Other |

#### `logistics-physical`

| Id | Label |
| --- | --- |
| `shipping` | Shipping |
| `courier-delivery` | Courier delivery |
| `warehousing-fulfillment` | Warehousing and fulfillment |
| `printing` | Printing |
| `field-service` | Field service |
| `inspection` | Inspection |
| `errands` | Errands |
| `logistics-physical-other` | Other |

#### `other`

| Id | Label |
| --- | --- |
| `question-answering` | Question answering |
| `other` | Other |

## Jurisdictions

Use:

- `global` by itself for a genuinely location-independent offering;
- ISO 3166-1 alpha-2 country codes such as `US`; or
- ISO 3166-2 subdivision codes such as `US-CA`.

Values must be uppercase except `global`, unique, and non-empty. Do not list
`global` together with narrower jurisdictions.

Jurisdiction means where the service can actually be fulfilled under its
supplier, legal, and operational controls. It is not merely where an HTTP
request can originate.

## Fulfillment mode

Each service declares a default and each skill may override it:

- `automated`: normally completes without a person;
- `human`: a person performs the material fulfillment; or
- `hybrid`: automation and human work are both material.

This is buyer-facing planning metadata. It does not grant authority or replace
readiness.

## Human parties

`humanParties` answers whether the skill needs identifying data for a human
party of record:

- `required`;
- `varies`; or
- `none`.

Omit the field only when unspecified. It is independent of fulfillment mode:
an automated product can still require a human party, and human fulfillment
can operate without collecting a buyer's personal identity.

## Placement checklist

Before publishing a service:

1. Select one approved `categoryFamily`.
2. Coordinate one stable `serviceType` with Daski.
3. List only supported jurisdictions.
4. Set the service default and any skill-specific fulfillment modes.
5. Declare `humanParties` for every skill when known.
6. Keep taxonomy, manifest, skill docs, signed listing artifacts, and tests in
   agreement.
