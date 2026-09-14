begin;
alter table public.bb_records drop constraint bb_records_entity_check;
alter table public.bb_records add constraint bb_records_entity_check check(entity in ('LoanCalendar','Loans','LoanSchedules','LoanPayments','LoanAllocations','Accounts','Cards','Transactions','Statements','BankPayments','PaymentAllocations','People','Shares','Repayments','InstallmentPlans','SavedViews','Settings','Labels','ReportConfig','SheetBaseline','ImportBatches','ImportRows','ImportHistory','AuditHistory','Operations'));
create unique index if not exists bb_loan_calendar_identity on public.bb_records(owner_id,(data->>'loanId'),(data->>'installmentNumber'),(data->>'calendarId')) where entity='LoanCalendar';
do $migration$
declare source text;
begin
 select pg_get_functiondef('public.bb_commit(uuid,text,bigint,text,text,jsonb,jsonb,jsonb,text)'::regprocedure) into source;
 if position('ent<>''Statements''' in source)=0 then raise exception 'Unexpected synchronization guard; inspect before migration.';end if;
 source:=replace(source,'ent<>''Statements'' or b is null or a is null or','ent not in (''Statements'',''LoanCalendar'') or (ent=''Statements'' and (b is null or a is null or');
 source:=replace(source,'then raise exception ''ACCESS_DENIED: Invalid synchronization change.''', ')) then raise exception ''ACCESS_DENIED: Invalid synchronization change.''');
 execute source;
end $migration$;
commit;
