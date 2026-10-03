"""Real temporary package bytes/keys/journals; no host install/service effects."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('selected_package_test',ROOT/'selected-runtime-package.py')
p=importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class FixtureHost:
    def __init__(self, directory, selected=False):
        directory.mkdir(parents=True,exist_ok=True)
        self.tree=p.Tree(directory,os.geteuid())
        self.events=[]
        self.now=1000
        self.backend_active=False
        self.boot='00000000-0000-4000-8000-000000000001'
        self.machine='a'*32
        self.source={n:(ROOT/n).read_bytes() for n in p.SOURCE_NAMES}
        self.revision='1'*40
        self.selected=selected
        self.unit_states={u:{'active':'inactive' if u==p.RENEW_SERVICE else 'active','enabled':'static' if u==p.RENEW_SERVICE else 'enabled'} for u in p.UNITS}
        for path in p.OWNED+p.PROTECTED+p.LEDGERS+(p.LOCK,p.TRANSACTION):
            if path in p.OPTIONAL:
                continue
            self.tree.path(path).parent.mkdir(parents=True,exist_ok=True)
        for d in ('/etc/proxypilot-a7','/var/lib/proxypilot-a7'):
            self.tree.path(d).mkdir(parents=True,exist_ok=True)
            self.put(d+'/retained.json',p.encoded({'fixture':'private protected configuration'}),0o600)
        private=self.tree.path(p.ROOT+'/supervisor-key.pem')
        public=self.tree.path(p.PUBLIC_KEY)
        subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(private)],check=True,capture_output=True)
        subprocess.run(['openssl','pkey','-in',str(private),'-pubout','-out',str(public)],check=True,capture_output=True)
        private.chmod(0o600); public.chmod(0o644)
        self.put('/etc/proxypilot-a8/supervisor-pub.pem',public.read_bytes(),0o600)
        der=subprocess.run(['openssl','pkey','-pubin','-in',str(public),'-outform','DER'],check=True,capture_output=True).stdout
        self.key_id=p.sha(der)
        for path in p.PROTECTED:
            if path in p.OPTIONAL or self.tree.path(path).exists():
                continue
            self.put(path,p.encoded({'retained':path}),0o600 if path.endswith('key.pem') or path.endswith('broker-config.json') else 0o644)
        files=p.candidate_files(self.source)
        if not selected:
            for path in [p.SUPERVISOR+'/'+n for n in p.SELECTED]+[p.ROOT+'/selected_browser_gateway.py',p.ROOT+'/selected_browser_policy.py']:
                files.pop(path)
            files[p.PROXY_UNIT]=p.literals(self.source['a3-install-proxy.py'],('UNIT_TEXT',))['UNIT_TEXT'].encode()
        for path,value in files.items():
            self.put(path,value+(b'\n# Prior reviewed code generation\n' if path.endswith('.py') else b''),0o644)
        sup_paths={p.SUPERVISOR+'/'+n for n in p.LEGACY+(p.SELECTED if selected else ())}|{p.SUP_UNIT,p.RENEW_SERVICE,p.RENEW_TIMER,p.PUBLIC_KEY}
        proxy_paths={p.ROOT+'/origin-proxy.py',p.PROXY_UNIT,p.ROOT+'/proxy-cert.pem',p.ROOT+'/proxy-key.pem'}
        if selected:
            proxy_paths|={p.ROOT+'/selected_browser_gateway.py',p.ROOT+'/selected_browser_policy.py'}
            self.tree.path(p.GATEWAY_STATE).mkdir(mode=0o700)
            self.put(p.GATEWAY_STATE+'/terminal.ledger',b'prior terminal gateway history\n',0o600)
            # Data is retained verbatim. It is not generated or granted as real
            # acceptance; production requires independently verified target proof.
            self.put(p.ROOT+'/selected-browser-acceptance.json',p.encoded({'fixture_only':'prior retained proof bytes'}),0o600)
        for path,owned in zip(p.JOURNALS,(sup_paths,proxy_paths,{p.BROKER,p.BROKER_UNIT})):
            record={'version':1,'phase':'installed','vm_uuid':p.VM_UUID,'files':{f:self.tree.pin(f)['sha256'] for f in sorted(owned)},'retained_custom':{'opaque':'unchanged'}}
            if path==p.JOURNALS[0]:record['key_id']=self.key_id
            self.put(path,p.encoded(record),0o600)
        self.put(p.LEDGERS[0],p.encoded({'version':1,'vm_uuid':p.VM_UUID,'active':None,'attempts':{'prior':{'state':'stopped'}},'runs':{'prior':{'guide_sha256':'a'*64}},'public_reviews':{},'supervisor_sha256':self.tree.pin(p.SUPERVISOR+'/a3-worker-supervisor.py')['sha256']}),0o600)
        self.put(p.LEDGERS[1],p.encoded({'version':1,'vm_uuid':p.VM_UUID,'calls':{'uncertain':{'state':'uncertain','reservation_usd':'0.17'}},'bindings':{'prior':{'revision':1}},'prices':{'immutable':'1'},'broker_sha256':self.tree.pin(p.BROKER)['sha256']}),0o600)
        self.initial={path:self.tree.inventory(path,missing=True) for path in p.PROTECTED}

    def put(self,path,value,mode):
        out=self.tree.path(path)
        out.parent.mkdir(parents=True,exist_ok=True)
        out.write_bytes(value);out.chmod(mode)

    def sources(self):
        return self.revision,copy.deepcopy(self.source)

    def identity(self):
        return {'machine_id':self.machine,'host_boot_id':self.boot,'vm_uuid':p.VM_UUID,'key_id':self.key_id,
                'vm_configuration_sha256':'2'*64,'nft_sha256':'3'*64,'managed_policy_sha256':'4'*64}

    def stopped_backend(self):
        if self.backend_active:p.refuse('Dashboard active fixture')

    def unit_check(self,active=True):
        expected='active' if active else 'inactive'
        for u,s in self.unit_states.items():
            if s['active']!=('inactive' if u==p.RENEW_SERVICE else expected):p.refuse('Mock unit boundary failed')
        return copy.deepcopy(self.unit_states)

    def unit_inventory(self,recovery=False):
        return copy.deepcopy(self.unit_states)

    def health(self,pins,key_id,selected):
        self.unit_check()
        if key_id!=self.key_id:p.refuse('Mock receipt identity changed')
        for f,pin in pins.items():
            if self.tree.pin(f,missing=True)!=pin:p.refuse('Mock serving package drift')
        for j in p.JOURNALS:
            for f,h in p.strict(self.tree.read(j))['files'].items():
                if self.tree.pin(f)['sha256']!=h:p.refuse('Mock loaded installer identity changed')
        actual=b'--serve --selected-control\n' in self.tree.read(p.PROXY_UNIT)
        if actual!=selected:p.refuse('Mock gateway/supervisor paired profile mismatch')

    def stop(self):
        self.events.append('stop')
        for u in self.unit_states:self.unit_states[u]['active']='inactive'
        self.unit_check(False)

    def start(self):
        self.events.append('start')
        for u in self.unit_states:self.unit_states[u]['active']='inactive' if u==p.RENEW_SERVICE else 'active'
        # Like the real daemons, update only the serving digest, never replay.
        for path,field,target in ((p.LEDGERS[0],'supervisor_sha256',p.SUPERVISOR+'/a3-worker-supervisor.py'),(p.LEDGERS[1],'broker_sha256',p.BROKER)):
            value=p.strict(self.tree.read(path));value[field]=self.tree.pin(target)['sha256']
            self.put(path,p.encoded(value),0o600)


@unittest.skipUnless(shutil.which('openssl'),'real Ed25519 fixture requires openssl')
class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.host=FixtureHost(Path(self.temp.name))
        self.package=p.Package(self.host,lambda:self.host.now)

    def authorize(self,operation):
        plan=self.package.plan(operation)
        self.package.review(operation,plan['plan_sha256'])
        return plan['plan_sha256']

    def apply(self):
        token=self.authorize('install')
        return self.package.apply(token)

    def test_plan_is_read_only_complete_and_exact_fixed_units(self):
        before={str(f):f.read_bytes() for f in Path(self.temp.name).rglob('*') if f.is_file()}
        result=self.package.plan('install')
        self.assertEqual(set(result['plan']['files']),set(p.OWNED))
        self.assertEqual(result['plan']['identity']['key_id'],self.host.key_id)
        self.assertEqual(result['plan']['files'][p.BROKER]['new']['sha256'],p.sha(self.host.source['a4-credential-broker.py']))
        self.assertEqual(before,{str(f):f.read_bytes() for f in Path(self.temp.name).rglob('*') if f.is_file()})
        self.assertFalse(result['acceptance_created']);self.assertEqual(self.host.events,[])
        self.assertIn('ReadWritePaths=/run/proxypilot-a3 /var/lib/proxypilot-a3-proof/selected-gateway',p.candidate_files(self.host.source)[p.PROXY_UNIT].decode())

    def test_initial_separate_install_and_rollback_preserve_real_key_identity_and_state(self):
        old={f:self.host.tree.pin(f,missing=True) for f in p.OWNED}
        protected=self.package.protected();state=p.idle_ledgers(self.host.tree)
        result=self.apply()
        self.assertTrue(result['applied']);self.assertEqual(self.host.events,['stop','start'])
        self.assertEqual(self.package.protected(),protected)
        self.assertTrue(self.package.ledger_equal(p.idle_ledgers(self.host.tree),state))
        self.assertFalse(self.host.tree.path(p.ROOT+'/selected-browser-acceptance.json').exists())
        self.assertEqual(self.package.tx()['phase'],'applied')
        self.package.restore('rollback',self.authorize('rollback'))
        self.assertEqual({f:self.host.tree.pin(f,missing=True) for f in p.OWNED},old)
        self.assertEqual(self.package.protected(),protected)
        self.assertEqual(p.idle_ledgers(self.host.tree),state)
        self.assertFalse(self.host.tree.path(p.GATEWAY_STATE).exists())

    def test_future_update_commit_and_rollback_preserve_gateway_history_and_stale_acceptance(self):
        self.host=FixtureHost(Path(self.temp.name)/'selected',True)
        self.package=p.Package(self.host,lambda:self.host.now)
        old={f:self.host.tree.pin(f,missing=True) for f in p.OWNED}
        protected=self.package.protected();state=p.idle_ledgers(self.host.tree)
        token=self.authorize('update');self.package.apply(token)
        self.assertEqual(self.package.protected(),protected)
        self.assertEqual(p.idle_ledgers(self.host.tree),state)
        self.package.commit(self.authorize('commit'))
        self.assertEqual(self.package.tx()['phase'],'committed')
        self.package.restore('rollback',self.authorize('rollback'))
        self.assertEqual({f:self.host.tree.pin(f,missing=True) for f in p.OWNED},old)
        self.assertEqual(self.package.protected(),protected)
        self.assertEqual(p.idle_ledgers(self.host.tree),state)

    def test_receipt_missing_expired_wrong_plan_operation_and_nonprivate_refused_before_service_effects(self):
        self.assertRaises(ValueError,self.package.apply,'f'*64)
        token=self.authorize('install');self.host.now+=901
        self.assertRaises(ValueError,self.package.apply,token)
        self.host.now=1000;token=self.authorize('install')
        self.assertRaises(ValueError,self.package.apply,'f'*64)
        self.host.tree.path(p.TRANSACTION+'/review.json').chmod(0o644)
        self.assertRaises(ValueError,self.package.apply,token)
        self.assertEqual(self.host.events,[])

    def test_each_source_installed_private_identity_and_ledger_drift_refuses_before_effects(self):
        for drift in ('source','revision','installed','key','machine','boot','ledger','configuration','gateway_latch','backend'):
            with self.subTest(drift=drift),tempfile.TemporaryDirectory() as directory:
                h=FixtureHost(Path(directory));pkg=p.Package(h,lambda:h.now)
                token=pkg.plan('install')['plan_sha256'];pkg.review('install',token)
                if drift=='source':h.source['selected_browser_worker.py']+=b'\n# altered\n'
                if drift=='revision':h.revision='9'*40
                if drift=='installed':h.put(p.BROKER,b'foreign code\n',0o644)
                if drift=='key':h.put(p.ROOT+'/supervisor-key.pem',b'foreign key\n',0o600)
                if drift=='machine':h.machine='b'*32
                if drift=='boot':h.boot='00000000-0000-4000-8000-000000000002'
                if drift=='ledger':h.put(p.LEDGERS[1],p.encoded({'version':1,'vm_uuid':p.VM_UUID,'calls':{'active':{'state':'reserved'}}}),0o600)
                if drift=='configuration':h.put('/etc/proxypilot-a4/broker-config.json',b'changed private config\n',0o600)
                if drift=='gateway_latch':
                    h.tree.path(p.GATEWAY_STATE).mkdir(mode=0o700);h.put(p.GATEWAY_STATE+'/selected-gateway-latch.json',b'{}',0o600)
                if drift=='backend':h.backend_active=True
                self.assertRaises(ValueError,pkg.apply,token)
                self.assertEqual(h.events,[])
                self.assertFalse(h.tree.path(p.TRANSACTION+'/transaction.json').exists())

    def test_unowned_selected_file_unknown_owned_set_and_unknown_state_refused(self):
        self.host.put(p.SUPERVISOR+'/'+p.SELECTED[0],b'foreign\n',0o644)
        self.assertRaises(ValueError,self.package.plan,'install')
        self.host.tree.path(p.SUPERVISOR+'/'+p.SELECTED[0]).unlink()
        value=p.strict(self.host.tree.read(p.JOURNALS[0]));value['files']['/etc/unreviewed']= 'f'*64
        self.host.put(p.JOURNALS[0],p.encoded(value),0o600)
        self.assertRaises(ValueError,self.package.plan,'install')
        self.assertEqual(self.host.events,[])

    def test_every_owned_replacement_crash_has_stopped_services_and_verified_paired_recovery(self):
        for failure_index in range(len(p.OWNED)):
            with self.subTest(failure_index=failure_index),tempfile.TemporaryDirectory() as directory:
                h=FixtureHost(Path(directory));pkg=p.Package(h,lambda:h.now)
                old={f:h.tree.pin(f,missing=True) for f in p.OWNED}
                token=pkg.plan('install')['plan_sha256'];pkg.review('install',token)
                original=h.tree.write
                def crash(path,data,mode):
                    if path==p.OWNED[failure_index]:raise OSError('synthetic replacement interruption')
                    return original(path,data,mode)
                with patch.object(h.tree,'write',crash):self.assertRaises(OSError,pkg.apply,token)
                self.assertEqual(h.events,['stop'])
                self.assertEqual(pkg.tx()['phase'],'replacing')
                recovery=pkg.plan('recover')['plan_sha256'];pkg.review('recover',recovery)
                result=pkg.restore('recover',recovery)
                self.assertTrue(result['recovered']);self.assertFalse(result['replayed'])
                self.assertEqual({f:h.tree.pin(f,missing=True) for f in p.OWNED},old)
                self.assertEqual(h.events,['stop','stop','start'])

    def test_recovery_after_host_reboot_needs_fresh_review_and_same_stable_identity(self):
        token=self.authorize('install')
        with patch.object(self.host,'start',side_effect=OSError('synthetic crash')):
            self.assertRaises(OSError,self.package.apply,token)
        self.host.boot='00000000-0000-4000-8000-000000000002'
        token=self.authorize('recover')
        self.host.machine='b'*32
        self.assertRaises(ValueError,self.package.restore,'recover',token)
        self.host.machine='a'*32
        self.package.restore('recover',self.authorize('recover'))

    def test_backup_stage_installed_state_and_journal_drift_refuse_before_rollback_stop(self):
        self.apply()
        for drift in ('backup','stage','installed','state','journal'):
            with self.subTest(drift=drift):
                tx=self.package.tx();path=p.TRANSACTION+'/'+tx['id']+'/old-0'
                if drift=='stage':path=p.TRANSACTION+'/'+tx['id']+'/new-0'
                if drift=='installed':path=p.BROKER
                if drift=='state':path=p.LEDGERS[1]
                if drift=='journal':path=p.TRANSACTION+'/transaction.json'
                old=self.host.tree.read(path)
                self.host.put(path,b'foreign bytes\n',0o600 if drift not in ('installed',) else 0o644)
                events=list(self.host.events)
                self.assertRaises((ValueError,KeyError),self.package.plan,'rollback')
                self.assertEqual(self.host.events,events)
                self.host.put(path,old,0o644 if drift=='installed' else 0o600)

    def test_source_drift_after_backup_stage_refuses_before_stop_and_no_package_transaction(self):
        token=self.authorize('install');original=self.host.tree.write
        def changed(path,data,mode):
            original(path,data,mode)
            if path.endswith('/new-0'):self.host.source['selected_browser_worker.py']+=b'\n# concurrent source drift\n'
        with patch.object(self.host.tree,'write',changed):self.assertRaises(ValueError,self.package.apply,token)
        self.assertEqual(self.host.events,[])
        self.assertFalse(self.host.tree.path(p.TRANSACTION+'/transaction.json').exists())

    def test_symlink_hardlink_parent_permissions_and_private_key_modes_refuse(self):
        for kind in ('symlink','hardlink','parent','keymode'):
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as directory:
                h=FixtureHost(Path(directory));pkg=p.Package(h)
                f=h.tree.path(p.BROKER)
                if kind=='symlink':
                    target=f.with_name('foreign');f.rename(target);f.symlink_to(target)
                if kind=='hardlink':os.link(f,f.with_name('alias'))
                if kind=='parent':f.parent.chmod(0o777)
                if kind=='keymode':h.tree.path(p.ROOT+'/supervisor-key.pem').chmod(0o644)
                self.assertRaises(ValueError,pkg.plan,'install');self.assertEqual(h.events,[])

    def test_file_bounds_duplicate_json_root_swap_and_concurrent_lock(self):
        self.assertRaises(ValueError,p.strict,b'{"v":1,"v":1}')
        self.assertRaises(ValueError,self.host.tree.read,p.BROKER,4)
        with self.host.tree.lock():
            with self.assertRaises(BlockingIOError):
                with self.host.tree.lock():pass
        original=self.host.tree.prefix
        self.host.tree.prefix=original/'replacement';self.host.tree.prefix.mkdir()
        self.assertRaises(ValueError,self.host.tree.read,p.BROKER)

    def test_candidate_literals_not_executed_and_fixed_bundle_refuses_unknown_file(self):
        sources=copy.deepcopy(self.host.source)
        sources['a3-install-supervisor.py']+=b'\nraise RuntimeError("must never execute candidate")\n'
        self.assertEqual(set(p.candidate_files(sources)),set(p.OWNED)-set(p.JOURNALS))
        sources['caller-extra.py']=b'pass\n'
        self.assertRaises(ValueError,p.candidate_files,sources)

    def test_cli_requires_actual_root_fixed_path_and_exposes_no_test_root_flag(self):
        with patch.object(p.os,'geteuid',return_value=1000),patch.object(p.sys,'argv',['helper','plan','--operation','install']):
            with self.assertRaises(SystemExit):p.main()
        with patch.object(p.os,'geteuid',return_value=0),patch.object(p.sys,'argv',['helper','plan','--operation','install']):
            with self.assertRaises(SystemExit):p.main()
        source=(ROOT/'selected-runtime-package.py').read_text()
        self.assertNotIn("add_argument('--root",source)
        self.assertNotIn("add_argument('--source-dir",source)
        self.assertNotIn("add_argument('--install-dir",source)

    def test_selected_model_reservation_before_broker_pin_is_never_idle(self):
        path=p.LEDGERS[0];value=p.strict(self.host.tree.read(path))
        value['selected_browser_model_runs']={'conversion':{'state':'active','calls':{'pending':{'state':'reserved'}}}}
        self.host.put(path,p.encoded(value),0o600)
        self.assertRaises(ValueError,self.package.plan,'install')
        self.assertEqual(self.host.events,[])
        value['selected_browser_model_runs']['conversion']['calls']['pending']['state']='completed'
        self.host.put(path,p.encoded(value),0o600)
        self.assertEqual(self.package.plan('install')['plan']['operation'],'install')
        value['selected_browser_model_runs']['conversion']['calls']['pending']['state']='unknown'
        self.host.put(path,p.encoded(value),0o600)
        self.assertRaises(ValueError,self.package.plan,'install')

    def test_production_database_admission_uses_all_actual_namespaces_without_mutating_them(self):
        host=p.Host.__new__(p.Host);host.tree=self.host.tree
        host.execute=lambda argv: b''
        dbpath=host.tree.path(p.SOURCE+'/data/db/proxypilot.db');dbpath.parent.mkdir(parents=True)
        tables=('ops_agent_runs','ops_selected_browser_runs','ops_website_review_runs','ops_browser_conversions',
                'ops_agent_model_calls','ops_selected_browser_model_reservations')
        with sqlite3.connect(dbpath) as db:
            for table in tables:db.execute(f'CREATE TABLE {table}(state TEXT NOT NULL)')
            db.execute("INSERT INTO ops_agent_runs VALUES('blocked')")
            db.execute("INSERT INTO ops_browser_conversions VALUES('interrupted')")
            db.execute("INSERT INTO ops_website_review_runs VALUES('blocked')")
        before=dbpath.read_bytes();host.stopped_backend();self.assertEqual(dbpath.read_bytes(),before)
        for table in tables:
            with self.subTest(table=table):
                with sqlite3.connect(dbpath) as db:db.execute(f"INSERT INTO {table} VALUES('reserved')")
                before=dbpath.read_bytes();self.assertRaises(ValueError,host.stopped_backend)
                self.assertEqual(dbpath.read_bytes(),before)
                with sqlite3.connect(dbpath) as db:db.execute(f"DELETE FROM {table} WHERE state='reserved'")

    def test_exact_a8_optin_and_only_readonly_backend_public_key_mounts(self):
        env=''.join(f'{k}={v}\n' for k,v in p.A8_SETTINGS.items())
        compose='services:\n  proxypilot:\n    privileged: true\n    pid: host\n    env_file:\n      - .env\n    volumes:\n'+p.A8_BLOCK+'      - ./data:/data\n'
        p.validate_a8_wiring(env,compose)
        for badenv,badcompose in ((env+'OPERATIONS_AGENT_VM_UUID=wrong\n',compose),
                                  (env.replace(p.VM_UUID,'wrong'),compose),
                                  (env,compose.replace('read_only: true','read_only: false',1)),
                                  (env,compose+'      - /run/proxypilot-a3:/run/proxypilot-a3\n'),
                                  (env,compose.replace('    pid: host','    user: root\n    pid: host')),
                                  (env,compose.replace(p.A8_BLOCK,''))):
            with self.subTest():self.assertRaises(ValueError,p.validate_a8_wiring,badenv,badcompose)

    def test_production_identity_proves_real_canonical_ed25519_and_proxy_pair_without_candidate_imports(self):
        tree=self.host.tree
        env=''.join(f'{k}={v}\n' for k,v in p.A8_SETTINGS.items())
        compose='services:\n  proxypilot:\n    privileged: true\n    pid: host\n    env_file:\n      - .env\n    volumes:\n'+p.A8_BLOCK+'      - ./data:/data\n'
        self.host.put(p.SOURCE+'/.env',env.encode(),0o600);self.host.put(p.SOURCE+'/docker-compose.yml',compose.encode(),0o644)
        for directory in ('/etc/proxypilot-a8','/run/proxypilot-a3-backend'):
            tree.path(directory).mkdir(parents=True,exist_ok=True);tree.path(directory).chmod(0o700)
        self.host.put('/etc/machine-id',b'a'*32+b'\n',0o644)
        key=tree.path(p.ROOT+'/proxy-key.pem');cert=tree.path(p.ROOT+'/proxy-cert.pem')
        subprocess.run(['openssl','req','-x509','-newkey','ed25519','-nodes','-days','7','-subj','/CN=demo.fractionate.ai','-keyout',str(key),'-out',str(cert)],check=True,capture_output=True)
        key.chmod(0o600);cert.chmod(0o644)
        host=p.Host.__new__(p.Host);host.tree=tree
        def execute(argv,timeout=30,input=None):
            if argv[0]=='openssl':
                fixed=[str(tree.path(a)) if a.startswith('/') else a for a in argv]
                return subprocess.run(fixed,input=input,check=True,capture_output=True,timeout=timeout).stdout
            if argv[:2]==['incus','query']:
                return p.encoded({'status':'Running'} if argv[2].endswith('/state') else {'type':'virtual-machine','config':{'volatile.uuid':p.VM_UUID},'expanded_devices':{'eth0':{'type':'nic','network':'incusbr0'}}})
            if argv[0]=='incus':return b'' if '/usr/bin/ls' in argv else b'4'*64+b'  fixed-policy\n'
            if argv[0]=='nft':return p.encoded({'nftables':[{'table':{'family':'bridge','name':'pp_a3_proof'}}]})
            raise AssertionError('Unexpected production host command')
        host.execute=execute
        identity=host.identity();self.assertEqual(identity['key_id'],self.host.key_id)
        self.assertRegex(identity['proxy_spki_sha256'],r'^[0-9a-f]{64}$')
        public=tree.read(p.PUBLIC_KEY);self.host.put(p.PUBLIC_KEY,public+b'\n',0o644)
        self.assertRaises(ValueError,host.identity);self.host.put(p.PUBLIC_KEY,public,0o644)
        original=key.read_bytes();key.write_bytes(tree.read(p.ROOT+'/supervisor-key.pem'));key.chmod(0o600)
        self.assertRaises(ValueError,host.identity);key.write_bytes(original);key.chmod(0o600)
        listener=socket.socket(socket.AF_UNIX);self.addCleanup(listener.close)
        listener.bind(str(tree.path(p.A8_SOCKET)));tree.path(p.A8_SOCKET).chmod(0o600)
        host.wiring(True)
        tree.path(p.A8_SOCKET).chmod(0o666);self.assertRaises(ValueError,host.wiring,True)

    def test_service_enablement_drift_after_rollback_review_is_refused_before_stop(self):
        self.apply();token=self.authorize('rollback');events=list(self.host.events)
        self.host.unit_states[p.PROXY_UNIT]['enabled']='disabled'
        self.assertRaises(ValueError,self.package.restore,'rollback',token)
        self.assertEqual(self.host.events,events)

    def test_interrupted_restore_recovers_recognized_mixed_bytes_and_never_replays(self):
        old={f:self.host.tree.pin(f,missing=True) for f in p.OWNED}
        self.apply();token=self.authorize('rollback');original=self.host.tree.write
        def crash(path,data,mode):
            if path==p.SUPERVISOR+'/a3-install-proxy.py':raise OSError('synthetic rollback interruption')
            return original(path,data,mode)
        with patch.object(self.host.tree,'write',crash):
            self.assertRaises(OSError,self.package.restore,'rollback',token)
        self.assertEqual(self.package.tx()['phase'],'restoring')
        token=self.authorize('recover');result=self.package.restore('recover',token)
        self.assertTrue(result['recovered']);self.assertFalse(result['replayed'])
        self.assertEqual({f:self.host.tree.pin(f,missing=True) for f in p.OWNED},old)

    def test_partial_service_stop_is_recoverable_before_any_target_replacement(self):
        old={f:self.host.tree.pin(f,missing=True) for f in p.OWNED}
        token=self.authorize('install')
        def failed_stop():
            self.host.events.append('partial_stop')
            self.host.unit_states[p.SUP_UNIT]['active']='inactive'
            raise OSError('synthetic partial service stop')
        with patch.object(self.host,'stop',failed_stop):self.assertRaises(OSError,self.package.apply,token)
        self.assertEqual(self.package.tx()['phase'],'prepared')
        self.assertEqual({f:self.host.tree.pin(f,missing=True) for f in p.OWNED},old)
        self.package.restore('recover',self.authorize('recover'))
        self.assertEqual({f:self.host.tree.pin(f,missing=True) for f in p.OWNED},old)

    def test_consumed_review_cannot_replay_and_recovery_binds_current_source(self):
        self.apply();tx=self.package.tx();events=list(self.host.events)
        self.assertRaises(ValueError,self.package.apply,tx['plan_sha256'])
        self.assertEqual(self.host.events,events)
        token=self.authorize('rollback')
        self.host.source['selected_browser_worker.py']+=b'\n# current source changed after recovery review\n'
        self.assertRaises(ValueError,self.package.restore,'rollback',token)
        self.assertEqual(self.host.events,events)

    def test_production_loaded_unit_identity_checks_recovery_reload_without_allowing_override(self):
        host=p.Host.__new__(p.Host);changed={}
        def execute(argv):
            unit=p.UNIT_ROOT+argv[2];prop=argv[3].split('=',1)[1]
            value=changed.get(prop,{'FragmentPath':unit,'DropInPaths':'','NeedDaemonReload':'no',
                                    'ActiveState':'inactive' if unit==p.RENEW_SERVICE else 'active','UnitFileState':'enabled'}[prop])
            return value.encode()+b'\n'
        host.execute=execute;self.assertEqual(set(host.unit_check()),set(p.UNITS))
        for prop,value in (('FragmentPath','/tmp/foreign-unit'),('DropInPaths','/etc/systemd/system/override.conf'),('ActiveState','activating')):
            changed[prop]=value;self.assertRaises(ValueError,host.unit_inventory,True);changed.clear()
        changed['NeedDaemonReload']='yes'
        self.assertRaises(ValueError,host.unit_check)
        self.assertEqual(set(host.unit_inventory(True)),set(p.UNITS))

    def test_new_directory_links_and_empty_gateway_removal_are_durable_before_service_effects(self):
        events=[];original_fsync=p.os.fsync;original_stop=self.host.stop;original_replace=p.os.replace
        def synced(fd):
            actual=str(Path(os.readlink('/proc/self/fd/'+str(fd))).relative_to(self.host.tree.prefix))
            events.append(('fsync','/'+actual));return original_fsync(fd)
        def stopped():
            events.append(('stop',None));return original_stop()
        def replaced(source,destination,**kwargs):
            parent=Path(os.readlink('/proc/self/fd/'+str(kwargs['dst_dir_fd'])))
            path='/'+str((parent/destination).relative_to(self.host.tree.prefix))
            events.append(('replace',path));return original_replace(source,destination,**kwargs)
        with patch.object(p.os,'fsync',synced),patch.object(p.os,'replace',replaced),patch.object(self.host,'stop',stopped):
            token=self.authorize('install');self.package.apply(token)
            first_stop=events.index(('stop',None));before=events[:first_stop]
            tx=self.package.tx();generation=p.TRANSACTION+'/'+tx['id']
            self.assertTrue(('fsync',str(Path(p.TRANSACTION).parent)) in before,'new transaction directory parent was not synced')
            self.assertTrue(('fsync',p.TRANSACTION) in before,'new generation directory parent was not synced')
            self.assertTrue(('fsync',generation) in before,'private staged bytes directory was not synced')
            journal=before.index(('replace',p.TRANSACTION+'/transaction.json'))
            self.assertEqual(before[journal-1][0],'fsync')
            self.assertTrue(before[journal-1][1].startswith(p.TRANSACTION+'/.selected-package-'))
            self.assertEqual(before[journal+1],('fsync',p.TRANSACTION))
            # Calling mkdir on an existing private directory is read-only.
            count=len(events);self.host.tree.mkdir(p.TRANSACTION,0o700);self.assertEqual(len(events),count)
            events.clear();token=self.authorize('rollback');self.package.restore('rollback',token)
            self.assertIn(('fsync',str(Path(p.GATEWAY_STATE).parent)),events)
            self.assertFalse(self.host.tree.path(p.GATEWAY_STATE).exists())


if __name__=='__main__':unittest.main()
