"""Preservation dispatch/recovery boundaries; authentic package proof is separate."""
import importlib.util
import io
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch
from test_review_runtime_refresh import FixtureHost, r, ROOT


class PreservedHost(FixtureHost):
    def source_profile(self):
        return {'source_sha':self.source_sha,'source_files':{'fixture':'a'*64}}

    def preservation(self):
        self.identity()
        return {str(p):[r.sha(p.read_bytes()),p.stat().st_mode&0o777] for p in self.preservation_paths()}

    def preservation_paths(self):
        return self.targets

    def preservation_db_idle(self):
        r.database_idle(self.database,selected=True)

    def healthy(self,digests,key,new=False,allow_work=False):
        return super().healthy(digests,key,new)


class PreservationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.host=PreservedHost(Path(self.temp.name));self.refresh=r.Refresh(self.host,self.host.root/'transaction')

    def test_failed_or_interrupted_preservation_requires_verification_only_recovery(self):
        self.refresh.apply();self.host.events.clear()
        with self.assertRaisesRegex(ValueError,'Incomplete refresh'):self.refresh.apply()
        self.refresh.rollback()
        self.assertFalse(any(e[0] in {'stop','start'} for e in self.host.events))
        self.refresh.apply();self.refresh.commit();self.refresh.apply();self.refresh.rollback()

    def test_old_incomplete_unknown_and_tampered_transactions_cannot_be_superseded(self):
        ordinary=FixtureHost(self.host.root/'ordinary');refresh=r.Refresh(ordinary,ordinary.root/'transaction')
        refresh.apply();ordinary.source_profile=lambda:self.host.source_profile()
        with self.assertRaisesRegex(ValueError,'Incomplete refresh'):refresh.preflight()
        original=refresh.journal.read_bytes()
        for version in (0,2,999):
            data=json.loads(original);data['version']=version;data['phase']='committed'
            refresh.journal.write_bytes(r.encoded(data))
            with self.assertRaises(ValueError):refresh.preflight()
        refresh.journal.write_bytes(original);refresh.rollback()
        self.refresh.apply();original=self.refresh.journal.read_bytes()
        for field,value in (('mode','install'),('files',{'/etc/shadow':['a'*64,0o600]}),('version',1)):
            data=json.loads(original);data[field]=value;self.refresh.journal.write_bytes(r.encoded(data))
            with self.assertRaises(ValueError):self.refresh.rollback()
        self.assertFalse(any(e[0] in {'stop','start'} for e in self.host.events))

    def test_current_database_namespaces_and_unknown_states_refuse_before_effects(self):
        for table,terminal in r.TERMINAL_DB.items():
            with self.subTest(table=table):
                with sqlite3.connect(self.host.database) as db:
                    db.execute(f'CREATE TABLE IF NOT EXISTS {table}(state TEXT)')
                for state in ('reserved','new_unknown_state',None):
                    with sqlite3.connect(self.host.database) as db:db.execute(f'INSERT INTO {table} VALUES(?)',(state,))
                    with self.assertRaises(ValueError):self.refresh.apply()
                    with sqlite3.connect(self.host.database) as db:db.execute(f'DELETE FROM {table}')
                with sqlite3.connect(self.host.database) as db:db.execute(f'INSERT INTO {table} VALUES(?)',(terminal[-1],))
                self.refresh.apply();self.refresh.rollback()
                with sqlite3.connect(self.host.database) as db:db.execute(f'DELETE FROM {table}')
        self.assertFalse(any(e[0] in {'stop','start'} for e in self.host.events))

    def test_selected_model_namespace_unknown_and_pending_calls_refuse(self):
        value=json.loads(self.host.ledgers[0].read_bytes())
        for state,call in (('unknown','completed'),('active','reserved'),('active','sent'),('active','unknown')):
            value['selected_browser_model_runs']={'conversion':{'state':state,'calls':{'call':{'state':call}}}}
            self.host.write(self.host.ledgers[0],r.encoded(value),0o600)
            with self.assertRaisesRegex(ValueError,'selected model reservation'):self.refresh.apply()
        value['selected_browser_model_runs']={'conversion':{'state':'cancelled','calls':{'call':{'state':'refused'}}}}
        self.host.write(self.host.ledgers[0],r.encoded(value),0o600)
        self.refresh.apply();self.refresh.commit()

    def test_actual_cli_dispatch_uses_preservation_without_runtime_writes_or_stop(self):
        original_path=Path
        original_refresh=r.Refresh
        def paths(value):
            return self.host.root/'fence.lock' if value=='/run/proxypilot-a3-fence.lock' else original_path(value)
        for action in ('preflight','apply','commit','preflight','apply','rollback'):
            output=io.StringIO()
            argv=['refresh',action,'--install-dir',str(self.host.root),'--source-dir',str(self.host.root),
                  '--source-sha',self.host.source_sha,'--database',str(self.host.database)]
            with patch.object(r.sys,'argv',argv),patch.object(r.os,'geteuid',return_value=0), \
                    patch.object(r,'Host',return_value=self.host),patch.object(r,'TRANSACTION',self.refresh.directory), \
                    patch.object(r,'Refresh',side_effect=lambda host:original_refresh(host,self.refresh.directory)), \
                    patch.object(r,'Path',side_effect=paths),redirect_stdout(output):r.main()
            result=json.loads(output.getvalue());self.assertTrue(result.get('preserved',True))
        self.assertFalse(any(e[0] in {'stop','start'} for e in self.host.events))
        self.assertFalse(any(e[0]=='write' and e[1] in self.host.targets for e in self.host.events))

    def test_actual_updater_dispatch_refuses_stale_helper_before_invocation(self):
        source=(ROOT.parent/'update.sh').read_text()
        function=re.search(r'^review_runtime_refresh\(\) \{\n[\s\S]*?^}',source,re.M)[0]
        checkout=self.host.root/'checkout';install=self.host.root/'install'
        for path in (checkout,install):(path/'scripts').mkdir(parents=True)
        helper='import sys\nprint("called:"+sys.argv[1])\n'
        (checkout/'scripts/review-runtime-refresh.py').write_text(helper)
        (install/'scripts/review-runtime-refresh.py').write_text(helper)
        code='\n'.join((f'SCRIPT_DIR={str(checkout)!r}',f'INSTALL_DIR={str(install)!r}',
            'EXPECTED_UPDATE_SHA='+'a'*40,'log() { printf "%s\\n" "$*"; }',function,'review_runtime_refresh preflight'))
        result=subprocess.run(['bash','-c',code],capture_output=True,text=True)
        self.assertEqual(result.returncode,0,result.stderr);self.assertIn('called:preflight',result.stdout)
        (install/'scripts/review-runtime-refresh.py').write_text(helper+'# drift\n')
        result=subprocess.run(['bash','-c',code],capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0);self.assertNotIn('called:',result.stdout)

    def test_clean_unenrolled_absence_does_not_hide_unit_only_or_partial_artifacts(self):
        root=self.host.root/'unenrolled';root.mkdir()
        a=SimpleNamespace(SELECTED_SOURCES=r.SELECTED,TARGET=root/'etc/a3/supervisor',STATE_DIR=root/'state/a3/supervisor',
            UNIT=root/'systemd/a3.service',RENEW_SERVICE=root/'systemd/renew.service',RENEW_TIMER=root/'systemd/renew.timer')
        a.proxy=SimpleNamespace(UNIT=root/'systemd/proxy.service',i=SimpleNamespace(UNIT=root/'systemd/fence.service'))
        host=r.Host.__new__(r.Host);host.a3=a;host.a4=SimpleNamespace(TARGET=root/'etc/a4/broker/code.py',JOURNAL=root/'state/a4/install.json',UNIT=root/'systemd/a4.service')
        host.a8=SimpleNamespace(KEY=root/'etc/a8/public.pem');host.secure=lambda _:None
        with patch.object(r,'TRANSACTION',root/'update/review-runtime-refresh'):
            host.unconfigured_absent()
            for path in (a.UNIT,a.proxy.UNIT,host.a4.JOURNAL,a.TARGET/r.SELECTED[0]):
                path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b'partial')
                with self.assertRaises(ValueError):host.unconfigured_absent()
                path.unlink()
                # Clear only directories owned by this disposable fixture.
                current=path.parent
                while current!=root and not any(current.iterdir()):current.rmdir();current=current.parent


if __name__=='__main__':unittest.main()
