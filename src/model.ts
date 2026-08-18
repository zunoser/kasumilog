export const DOMAINS = [
  "administration",
  "politics",
  "legislature",
  "judiciary",
] as const;

export type Domain = (typeof DOMAINS)[number];
export type AccountStatus = "active" | "inactive";
export type AccountSubjectRelation = "publisher" | "represents" | "personal";
export type ClassificationSource = "account" | "role" | "manual";

export interface Government {
  readonly id: string;
  readonly name: string;
  readonly jurisdiction: string;
}

export interface Organization {
  readonly kind: "organization";
  readonly id: string;
  readonly name: string;
  readonly domain: Domain;
  readonly government: string;
}

export interface Person {
  readonly kind: "person";
  readonly id: string;
  readonly name: string;
}

export interface Role {
  readonly kind: "role";
  readonly id: string;
  readonly name: string;
  readonly domain: Domain;
  readonly government: string;
}

export type Subject = Organization | Person | Role;

export type SubjectReference =
  | { readonly kind: "organization"; readonly id: string }
  | { readonly kind: "person"; readonly id: string }
  | { readonly kind: "role"; readonly id: string };

export interface AccountSubjectLink {
  readonly subject: SubjectReference;
  readonly relation: AccountSubjectRelation;
}

export interface Account {
  readonly id: string;
  readonly network: "twitter";
  readonly twitterId: string;
  readonly handle: `@${string}`;
  readonly displayName: string;
  readonly subjects: readonly AccountSubjectLink[];
  readonly status: AccountStatus;
  readonly verifiedAt: string;
}

export interface RoleAssignment {
  readonly person: string;
  readonly role: string;
  readonly sequence?: number;
  readonly validFrom: string;
  readonly validTo?: string;
}

export interface Catalog {
  readonly governments: readonly Government[];
  readonly organizations: readonly Organization[];
  readonly persons: readonly Person[];
  readonly roles: readonly Role[];
  readonly roleAssignments: readonly RoleAssignment[];
  readonly accounts: readonly Account[];
}

export interface PostInput {
  readonly publisher: string;
  readonly publishedAt: string;
  readonly originalPublisher?: string;
  readonly role?: string;
  readonly domain?: Domain;
}

export interface PostMetadata {
  readonly publisher: string;
  readonly originalPublisher?: string;
  readonly publishedAt: string;
  readonly organization?: string;
  readonly person?: string;
  readonly role?: string;
  readonly government?: string;
  readonly domain: Domain;
  readonly classifiedBy: ClassificationSource;
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function findSubject(catalog: Catalog, reference: SubjectReference): Subject {
  const collections: Record<SubjectReference["kind"], readonly Subject[]> = {
    organization: catalog.organizations,
    person: catalog.persons,
    role: catalog.roles,
  };
  const subject = collections[reference.kind].find(({ id }) => id === reference.id);

  if (!subject) {
    throw new Error(`Unknown ${reference.kind}: ${reference.id}`);
  }

  return subject;
}

function findAccount(catalog: Catalog, accountId: string): Account {
  const account = catalog.accounts.find(({ id }) => id === accountId);
  if (!account) {
    throw new Error(`Unknown account: ${accountId}`);
  }
  return account;
}

function findRoleAssignment(
  catalog: Catalog,
  roleId: string,
  publishedAt: string,
): RoleAssignment {
  const publishedTime = Date.parse(publishedAt);
  const assignment = catalog.roleAssignments.find(
    ({ role, validFrom, validTo }) =>
      role === roleId &&
      Date.parse(validFrom) <= publishedTime &&
      (!validTo || publishedTime < Date.parse(validTo)),
  );

  if (!assignment) {
    throw new Error(`No ${roleId} assignment at ${publishedAt}`);
  }
  return assignment;
}

export function createPostMetadata(
  catalog: Catalog,
  input: PostInput,
): PostMetadata {
  if (!isInstant(input.publishedAt)) {
    throw new Error(`Invalid publishedAt: ${input.publishedAt}`);
  }

  const account = findAccount(catalog, input.publisher);
  if (input.originalPublisher) {
    findAccount(catalog, input.originalPublisher);
  }

  const publisherLink = account.subjects.find(({ relation }) => relation === "publisher");
  if (!publisherLink) {
    throw new Error(`Account has no publisher subject: ${account.id}`);
  }
  const publisher = findSubject(catalog, publisherLink.subject);
  const organization = publisher.kind === "organization" ? publisher : undefined;

  let person: string | undefined;
  let role: Role | undefined;
  if (input.role) {
    role = catalog.roles.find(({ id }) => id === input.role);
    if (!role) {
      throw new Error(`Unknown role: ${input.role}`);
    }
    if (
      !account.subjects.some(
        ({ relation, subject }) =>
          relation === "represents" &&
          subject.kind === "role" &&
          subject.id === role?.id,
      )
    ) {
      throw new Error(`Account does not represent role: ${input.role}`);
    }
    const assignment = findRoleAssignment(catalog, role.id, input.publishedAt);
    person = assignment.person;
    if (organization && organization.government !== role.government) {
      throw new Error(`Government mismatch for role: ${role.id}`);
    }
  }

  if (!input.domain && !role && !organization) {
    throw new Error(`Personal publishers require a manual domain: ${account.id}`);
  }

  const domain = input.domain ?? role?.domain ?? organization?.domain;
  if (!domain) {
    throw new Error(`Unable to classify post: ${account.id}`);
  }

  return {
    publisher: account.id,
    originalPublisher: input.originalPublisher,
    publishedAt: input.publishedAt,
    organization: organization?.id,
    person,
    role: role?.id,
    government: role?.government ?? organization?.government,
    domain,
    classifiedBy: input.domain ? "manual" : role ? "role" : "account",
  };
}

export function validateCatalog(catalog: Catalog): void {
  const assertUnique = (label: string, values: readonly string[]) => {
    if (new Set(values).size !== values.length) {
      throw new Error(`Duplicate ${label}`);
    }
  };

  assertUnique("government id", catalog.governments.map(({ id }) => id));
  assertUnique("organization id", catalog.organizations.map(({ id }) => id));
  assertUnique("person id", catalog.persons.map(({ id }) => id));
  assertUnique("role id", catalog.roles.map(({ id }) => id));
  assertUnique("account id", catalog.accounts.map(({ id }) => id));
  assertUnique("Twitter id", catalog.accounts.map(({ twitterId }) => twitterId));
  assertUnique("Twitter handle", catalog.accounts.map(({ handle }) => handle.toLowerCase()));

  const governmentIds = new Set(catalog.governments.map(({ id }) => id));
  for (const subject of [...catalog.organizations, ...catalog.roles]) {
    if (!governmentIds.has(subject.government)) {
      throw new Error(`Unknown government on ${subject.kind}: ${subject.id}`);
    }
  }

  for (const account of catalog.accounts) {
    if (!/^\d+$/.test(account.twitterId)) {
      throw new Error(`Invalid Twitter id: ${account.twitterId}`);
    }
    if (!/^@[A-Za-z0-9_]{1,15}$/.test(account.handle)) {
      throw new Error(`Invalid Twitter handle: ${account.handle}`);
    }
    if (!isDate(account.verifiedAt)) {
      throw new Error(`Invalid verifiedAt: ${account.verifiedAt}`);
    }
    if (account.status !== "active" && account.status !== "inactive") {
      throw new Error(`Invalid account status: ${account.status}`);
    }

    const links = account.subjects.map(
      ({ relation, subject }) => `${relation}:${subject.kind}:${subject.id}`,
    );
    assertUnique(`subject link on ${account.id}`, links);
    if (account.subjects.filter(({ relation }) => relation === "publisher").length !== 1) {
      throw new Error(`Account must have exactly one publisher: ${account.id}`);
    }
    for (const { relation, subject } of account.subjects) {
      if (relation === "personal" && subject.kind !== "person") {
        throw new Error(`Personal link must reference a person: ${account.id}`);
      }
      findSubject(catalog, subject);
    }
  }

  const roleSequences = catalog.roleAssignments
    .filter(({ sequence }) => sequence !== undefined)
    .map(({ role, sequence }) => `${role}:${sequence}`);
  assertUnique("role sequence", roleSequences);

  for (const assignment of catalog.roleAssignments) {
    if (!catalog.persons.some(({ id }) => id === assignment.person)) {
      throw new Error(`Unknown person on role assignment: ${assignment.person}`);
    }
    if (!catalog.roles.some(({ id }) => id === assignment.role)) {
      throw new Error(`Unknown role on role assignment: ${assignment.role}`);
    }
    if (
      assignment.sequence !== undefined &&
      (!Number.isInteger(assignment.sequence) || assignment.sequence <= 0)
    ) {
      throw new Error(`Invalid role sequence: ${assignment.sequence}`);
    }
    if (!isInstant(assignment.validFrom)) {
      throw new Error(`Invalid validFrom: ${assignment.validFrom}`);
    }
    if (assignment.validTo && !isInstant(assignment.validTo)) {
      throw new Error(`Invalid validTo: ${assignment.validTo}`);
    }
    if (assignment.validTo && Date.parse(assignment.validFrom) >= Date.parse(assignment.validTo)) {
      throw new Error(`Invalid role assignment interval: ${assignment.role}`);
    }
  }

  for (const [index, assignment] of catalog.roleAssignments.entries()) {
    const start = Date.parse(assignment.validFrom);
    const end = assignment.validTo ? Date.parse(assignment.validTo) : Infinity;
    for (const other of catalog.roleAssignments.slice(index + 1)) {
      if (assignment.role !== other.role) continue;
      const otherStart = Date.parse(other.validFrom);
      const otherEnd = other.validTo ? Date.parse(other.validTo) : Infinity;
      if (start < otherEnd && otherStart < end) {
        throw new Error(`Overlapping role assignments: ${assignment.role}`);
      }
    }
  }
}
