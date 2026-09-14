begin;
alter table public.bb_records drop constraint bb_records_entity_check;
alter table public.bb_records add constraint bb_records_entity_check check(entity in ('Loans','LoanSchedules','LoanPayments','LoanAllocations','Accounts','Cards','Transactions','Statements','BankPayments','PaymentAllocations','People','Shares','Repayments','InstallmentPlans','SavedViews','Settings','Labels','ReportConfig','SheetBaseline','ImportBatches','ImportRows','ImportHistory','AuditHistory','Operations'));
commit;
