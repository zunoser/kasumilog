import type {
  Account,
  AccountSubjectLink,
  Catalog,
  Organization,
} from "./model.ts";

const JAPAN = "japan";
const VERIFIED_AT = "2026-08-17";

const organization = (id: string, name: string): Organization => ({
  kind: "organization",
  id,
  name,
  domain: "administration",
  government: JAPAN,
});

const organizations = [
  organization("cabinet_secretariat", "内閣官房"),
  organization("cabinet_office", "内閣府"),
  organization("government_public_relations_office", "内閣府大臣官房政府広報室"),
  organization("digital_agency", "デジタル庁"),
  organization("ministry_internal_affairs_communications", "総務省"),
  organization("fire_and_disaster_management_agency", "消防庁"),
  organization("ministry_justice", "法務省"),
  organization("immigration_services_agency", "出入国在留管理庁"),
  organization("ministry_foreign_affairs", "外務省"),
  organization("ministry_finance", "財務省"),
  organization("national_tax_agency", "国税庁"),
  organization("ministry_education_culture_sports_science_technology", "文部科学省"),
  organization("ministry_health_labour_welfare", "厚生労働省"),
  organization("ministry_agriculture_forestry_fisheries", "農林水産省"),
  organization("ministry_economy_trade_industry", "経済産業省"),
  organization("japan_patent_office", "特許庁"),
  organization("ministry_land_infrastructure_transport_tourism", "国土交通省"),
  organization("japan_coast_guard", "海上保安庁"),
  organization("japan_meteorological_agency", "気象庁"),
  organization("ministry_environment", "環境省"),
  organization("nuclear_regulation_authority", "原子力規制委員会"),
  organization("ministry_defense", "防衛省"),
  organization("reconstruction_agency", "復興庁"),
  organization("national_police_agency", "警察庁"),
  organization("financial_services_agency", "金融庁"),
  organization("consumer_affairs_agency", "消費者庁"),
  organization("japan_fair_trade_commission", "公正取引委員会"),
  organization("personal_information_protection_commission", "個人情報保護委員会"),
] as const;

const publisher = (id: string): AccountSubjectLink => ({
  relation: "publisher",
  subject: { kind: "organization", id },
});

const representsRole = (id: string): AccountSubjectLink => ({
  relation: "represents",
  subject: { kind: "role", id },
});

const personalAccount = (
  twitterId: string,
  handle: `@${string}`,
  displayName: string,
  personId: string,
): Account => ({
  id: `twitter:${twitterId}`,
  network: "twitter",
  twitterId,
  handle,
  displayName,
  defaultDomain: "politics",
  subjects: [
    { relation: "publisher", subject: { kind: "person", id: personId } },
    { relation: "personal", subject: { kind: "person", id: personId } },
  ],
  status: "active",
  verifiedAt: VERIFIED_AT,
});

const account = (
  twitterId: string,
  handle: `@${string}`,
  displayName: string,
  organizationId: string,
  subjects: readonly AccountSubjectLink[] = [],
): Account => ({
  id: `twitter:${twitterId}`,
  network: "twitter",
  twitterId,
  handle,
  displayName,
  subjects: [publisher(organizationId), ...subjects],
  status: "active",
  verifiedAt: VERIFIED_AT,
});

const accounts = [
  account("412940784", "@kantei", "首相官邸", "cabinet_secretariat", [
    representsRole("prime_minister"),
  ]),
  personalAccount("218434058", "@takaichi_sanae", "高市早苗", "sanae_takaichi"),
  account("2904127170", "@cao_japan", "内閣府", "cabinet_office"),
  account("461064204", "@gov_online", "政府広報オンライン", "government_public_relations_office"),
  account("1312820383532294144", "@digital_jpn", "デジタル庁", "digital_agency"),
  account("1469058582", "@MIC_JAPAN", "総務省", "ministry_internal_affairs_communications"),
  account("137272821", "@FDMA_JAPAN", "総務省消防庁", "fire_and_disaster_management_agency"),
  account("1178494159", "@MOJ_HOUMU", "法務省", "ministry_justice"),
  account("3720424033", "@MOJ_IMMI", "出入国在留管理庁", "immigration_services_agency"),
  account("303730149", "@MofaJapan_jp", "外務省", "ministry_foreign_affairs"),
  account("331514169", "@MOF_Japan", "財務省", "ministry_finance"),
  account("236682791", "@NTA_Japan", "国税庁", "national_tax_agency"),
  account("242156036", "@mextjapan", "文部科学省 MEXT", "ministry_education_culture_sports_science_technology"),
  account("180585090", "@MHLWitter", "厚生労働省", "ministry_health_labour_welfare"),
  account("2335919749", "@MAFF_JAPAN", "農林水産省", "ministry_agriculture_forestry_fisheries"),
  account("266566401", "@meti_NIPPON", "経済産業省", "ministry_economy_trade_industry"),
  account("281874178", "@jpo_NIPPON", "特許庁", "japan_patent_office"),
  account("571429134", "@MLIT_JAPAN", "国土交通省", "ministry_land_infrastructure_transport_tourism"),
  account("2916368839", "@JCG_koho", "海上保安庁", "japan_coast_guard"),
  account("2923658012", "@JMA_kishou", "気象庁", "japan_meteorological_agency"),
  account("286056244", "@Kankyo_Jpn", "環境省", "ministry_environment"),
  account("719219671", "@gensiryokukisei", "原子力規制委員会 / NRA Japan", "nuclear_regulation_authority"),
  account("268732024", "@ModJapan_jp", "防衛省・自衛隊", "ministry_defense"),
  account("2931953732", "@Fukkocho_JAPAN", "復興庁", "reconstruction_agency"),
  account("2891516809", "@NPA_KOHO", "警察庁", "national_police_agency"),
  account("276848601", "@fsa_JAPAN", "金融庁", "financial_services_agency"),
  account("240204834", "@caa_shohishacho", "消費者庁", "consumer_affairs_agency"),
  account("2455900080", "@jftc", "公正取引委員会", "japan_fair_trade_commission"),
  account("1401738180202622982", "@PPC_JPN", "個人情報保護委員会", "personal_information_protection_commission"),
] as const;

export const catalog: Catalog = {
  governments: [{ id: JAPAN, name: "日本国政府", jurisdiction: "JP" }],
  organizations,
  persons: [
    { kind: "person", id: "shigeru_ishiba", name: "石破 茂" },
    { kind: "person", id: "sanae_takaichi", name: "高市 早苗" },
  ],
  roles: [
    {
      kind: "role",
      id: "prime_minister",
      name: "内閣総理大臣",
      domain: "politics",
      government: JAPAN,
    },
  ],
  roleAssignments: [
    {
      person: "shigeru_ishiba",
      role: "prime_minister",
      sequence: 102,
      validFrom: "2024-10-01T00:00:00+09:00",
      validTo: "2024-11-11T00:00:00+09:00",
    },
    {
      person: "shigeru_ishiba",
      role: "prime_minister",
      sequence: 103,
      validFrom: "2024-11-11T00:00:00+09:00",
      validTo: "2025-10-21T00:00:00+09:00",
    },
    {
      person: "sanae_takaichi",
      role: "prime_minister",
      sequence: 104,
      validFrom: "2025-10-21T00:00:00+09:00",
      validTo: "2026-02-18T00:00:00+09:00",
    },
    {
      person: "sanae_takaichi",
      role: "prime_minister",
      sequence: 105,
      validFrom: "2026-02-18T00:00:00+09:00",
    },
  ],
  accounts,
};
