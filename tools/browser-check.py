import json,re,os,tempfile,subprocess,shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
project=Path(__file__).resolve().parents[1]
root=project/'public'
fixture=json.loads(subprocess.check_output(['node',str(project/'tests/browser-fixture.mjs')],text=True))
output=Path(tempfile.mkdtemp(prefix='cardbills-browser-'))
checks=[]
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('BROWSER_EXECUTABLE') or shutil.which('chromium') or p.chromium.executable_path,headless=True,args=['--no-sandbox'])
    for mode,w,h in [('desktop',1440,1000),('mobile',390,844)]:
        page=browser.new_page(viewport={'width':w,'height':h},device_scale_factor=1)
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        def load(name,script):
            html=(root/name).read_text()
            html=re.sub(r'<link\b[^>]*>','',html)
            html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S)
            page.set_content(html)
            page.add_style_tag(content=(root/'styles.css').read_text())
            page.evaluate('''data => {window.fetch=async(path,options={})=>{let result;if(path==='/api/session')result={signedIn:false};else if(path==='/api/rpc'){const req=JSON.parse(options.body);result={data:req.action==='apiBootstrap'?data.boot:req.action==='apiList'?data.lists[req.args[0]]:[]};}else result={next:'/login.html'};return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});};}''',fixture)
            page.add_script_tag(content=(root/script).read_text())
        load('login.html','login.js');page.wait_for_selector('#username:focus')
        assert page.locator('#username').get_attribute('autocomplete')=='username'
        page.locator('#password').fill('synthetic-password')
        page.locator('#show-password').click()
        assert page.locator('#password').get_attribute('type')=='text'
        page.locator('#show-password').click()
        assert page.locator('#password').get_attribute('type')=='password'
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),mode+' login overflow'
        page.screenshot(path=str(output/f'login-{mode}.png'),full_page=True)
        checks.append(mode+' login layout and password toggle')
        load('app.html','app.js');page.get_by_role('heading',name='Recent transactions',exact=True).wait_for()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),mode+' workspace overflow'
        page.screenshot(path=str(output/f'workspace-{mode}.png'),full_page=True)
        checks.append(mode+' workspace overview')
        page.locator('#nav').get_by_role('button',name='Transactions',exact=True).click()
        page.get_by_role('button',name='Import reviewed package',exact=True).wait_for()
        page.get_by_role('button',name='Import reviewed package',exact=True).click()
        assert page.locator('#dialog').evaluate('(el)=>el.open')
        page.get_by_role('button',name='Close dialog',exact=True).click()
        assert not page.locator('#dialog').evaluate('(el)=>el.open')
        checks.append(mode+' transaction navigation and import dialog')
        page.locator('#nav').get_by_role('button',name='Cards and Accounts',exact=True).click()
        page.get_by_role('button',name='Everyday account',exact=True).wait_for()
        page.locator('#nav').get_by_role('button',name='Money Owed',exact=True).click()
        page.get_by_text('No records to display.',exact=True).wait_for()
        assert not errors,errors
        checks.append(mode+' accounts and empty collections with zero JavaScript errors')
        page.close()
    browser.close()
result={'checks':checks,'passed':len(checks),'data':'Synthetic records','browser':'Chromium','mode':'Offline DOM with mocked fetch; network navigation is restricted in this environment'}
(output/'browser-results.json').write_text(json.dumps(result,indent=2))
print(json.dumps(result,indent=2));print('Results: '+str(output))
