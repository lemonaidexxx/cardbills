# Data dictionary

Schema version 4. Each table is a Sheet tab named CC_ followed by the entity name.

## Common columns

Every table begins with id, revision, createdAt and updatedAt. IDs are stable record identifiers. Revision tracks changes. Timestamps use ISO representation.

## Tables

### CC_Accounts

Billing accounts and currency.

`bank nickname currency status reviewStatus sharedLimitGroup`

### CC_Cards

Physical cards and account relationships.

`accountId product nickname lastFour cardholder relationship replacesCardId status`

### CC_Transactions

Signed individual activities.

`accountId cardId statementId transactionDate postingDate originalDescription description amountMinor currency type category tags notes sourceKey sourceRef reviewStatus installmentPlanId installmentNumber status`

### CC_Statements

Official bills, dates and Calendar metadata.

`accountId statementDate periodStart periodEnd dueDate balanceMinor minimumMinor currency status reconciliation calendarMode calendarId eventId syncedAt fingerprint syncError attempts nextRetry`

### CC_BankPayments

Payments to the card issuer.

`accountId date amountMinor currency status reference notes matchedTransactionId`

### CC_PaymentAllocations

Amounts assigned from bank payments to statements.

`paymentId statementId amountMinor status`

### CC_People

Personal collection counterparties.

`name contact notes status`

### CC_Shares

Amounts assigned from transactions to people.

`transactionId personId amountMinor currency requestStatus requestDate expectedDate notes status`

### CC_Repayments

Personal receipts, credits and waivers.

`shareId date amountMinor currency type status reference notes`

### CC_InstallmentPlans

Financing schedules and transaction links.

`accountId cardId originTransactionId reference startDate monthlyMinor currency count status notes`

### CC_SavedViews

Reusable filters and ordering.

`name scope filters sort status`

### CC_Settings

Application settings.

`key value`

### CC_Labels

Editable interface labels.

`key value`

### CC_ReportConfig

Approved report fields and defaults.

`key value`

### CC_SheetBaseline

Last accepted record payloads.

`entity recordId payload`

### CC_ImportBatches

Staged CSV import state.

`fingerprint state mappings validation selection progress expiresAt error startRow rowCount groups counts`

### CC_ImportRows

Staged CSV row payloads.

`batchId rowIndex source result digest`

### CC_ImportHistory

Import counts and outcomes.

`sourceHash outcome accepted rejected suspect skipped summary`

### CC_AuditHistory

Operation change summaries.

`actor action entity recordId summary correlationId`

### CC_Operations

Recovery journal.

`kind state payload error`

## Field conventions

Fields ending in Minor store integer minor currency units. PHP uses two decimal places: 125050 represents PHP 1,250.50. Blank statement balanceMinor or minimumMinor means unknown. Dates use local YYYY-MM-DD. Calendar and audit timestamps are separate from financial date-only fields.

accountId, cardId, statementId, transactionId, paymentId, personId, shareId and installmentPlanId link to stable IDs. Card lastFour is a four-character masked suffix. cardholder is a label; it does not create a receivable. replacesCardId is populated only when a specific replacement relationship is established.

Transactions retain originalDescription, the editable display description, sourceKey and sourceRef. sourceKey combines the original source hash and source row. Matching transaction content can represent legitimate repeated activity.

## Status values

**Accounts.status**: `ACTIVE`, `ARCHIVED`.

**Accounts.reviewStatus**: `REVIEW`, `VERIFIED`.

**Cards.status**: `ACTIVE`, `ARCHIVED`.

**Cards.relationship**: `PRIMARY`, `SUPPLEMENTARY`, `REPLACEMENT`, `UNKNOWN`.

**Transactions.type**: `PURCHASE`, `FEE`, `INTEREST`, `CASH_ADVANCE`, `BANK_PAYMENT`, `REFUND`, `REBATE`, `TRANSFER`, `ADJUSTMENT`, `INSTALLMENT`, `FINANCED_PRINCIPAL`, `UNKNOWN`.

**Transactions.status**: `ACTIVE`, `VOID`.

**Transactions.reviewStatus**: `REVIEW`, `VERIFIED`, `DUPLICATE_CANDIDATE`.

**Statements.status**: `OPEN`, `ARCHIVED`.

**Statements.reconciliation**: `UNVERIFIED`, `VERIFIED`.

**Statements.calendarMode**: `OFF`, `ON`, `PAUSED`.

**BankPayments.status**: `PENDING`, `CONFIRMED`, `REVERSED`.

**PaymentAllocations.status**: `ACTIVE`, `REVERSED`.

**People.status**: `ACTIVE`, `ARCHIVED`.

**Shares.status**: `ACTIVE`, `VOID`.

**Shares.requestStatus**: `NOT_REQUESTED`, `REQUESTED`, `DISPUTED`.

**Repayments.type**: `CASH`, `REFUND_CREDIT`, `WAIVER`, `ADJUSTMENT`.

**Repayments.status**: `PENDING`, `CONFIRMED`, `REVERSED`.

**InstallmentPlans.status**: `ACTIVE`, `COMPLETED`, `ARCHIVED`.

**SavedViews.status**: `ACTIVE`, `ARCHIVED`.

**SavedViews.scope**: `Transactions`, `Shares`, `Statements`, `BankPayments`, `Repayments`.

## Reviewed package

The reviewed JSON format is cardbills-reviewed-v1. It contains a package UUID, source hash, expected control totals and an ordered records array. Each record identifies one of Accounts, Cards, Statements or Transactions and includes its stable data. The importer processes bounded batches using package-derived operation IDs and writes ImportHistory and AuditHistory. The source package remains in private local storage.

## Financial interpretation

Transaction signed totals measure recorded activity. Official statement balances come from bank statements. Confirmed payment allocations reduce statement remainder. Confirmed personal repayment and adjustment records reduce assigned shares. Request status remains independent of settlement. Archived cards preserve their previous records. UNKNOWN transaction types remain available for classification.
