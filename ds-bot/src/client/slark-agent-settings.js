import { createElement as h, useEffect, useRef, useState } from 'react'
import { Card } from './bot-settings.js'
import { t } from './i18n.js'

const hostNow = () => window.__DSH_DESKTOP_HOST__
const readyHost = host => host?.collaborationGroupPreparation && host.collaborationGroupActivation &&
  host.collaborationGroupMembers && host.collaborationWorkspace
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const intentKey = (roomId, key) => `ds-bot:slark-room-intent:${roomId}:${key}`
const requestIdFor = (roomId, key) => {
  const saved = localStorage.getItem(intentKey(roomId, key))
  if (saved && uuid.test(saved)) return saved
  const created = crypto.randomUUID()
  localStorage.setItem(intentKey(roomId, key), created)
  return created
}
const clearRequestId = (roomId, key) => localStorage.removeItem(intentKey(roomId, key))

// A native DS Bot room stays the one visible group. Slark keeps its bridge Session private.
export function SlarkAgentSettings({ room }) {
  const [available, setAvailable] = useState(false)
  const [group, setGroup] = useState(null)
  const [choices, setChoices] = useState([])
  const [projects, setProjects] = useState([])
  const [scope, setScope] = useState(null)
  const [members, setMembers] = useState([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const check = () => setAvailable(!!readyHost(hostNow()))
    check()
    const timer = window.setInterval(check, 2000)
    return () => { alive.current = false; window.clearInterval(timer) }
  }, [])
  if (!available) return null

  const connect = async () => {
    const host = hostNow()
    if (!readyHost(host) || busy) return
    setBusy(true); setProblem('')
    try {
      let prepared = await host.collaborationGroupPreparation({ operation: 'native_room', room_id: room.id })
      if (!alive.current || hostNow() !== host) return
      if (prepared.state === 'preparing') {
        const key = `activate:${prepared.group_id}`
        const activated = await host.collaborationGroupActivation({ request_id: requestIdFor(room.id, key),
          workspace_id: prepared.workspace_id, session_id: prepared.session_id })
        if (activated.state !== 'group_active' || activated.group_id !== prepared.group_id)
          throw Error('Activation needs reconciliation')
        prepared = { ...prepared, state: 'group_active', version: 2 }
        clearRequestId(room.id, key)
      }
      if (prepared.state !== 'group_active' || prepared.room_id !== room.id) throw Error('Room unavailable')
      const coordinate = { workspace_id: prepared.workspace_id, session_id: prepared.session_id }
      const [snapshot, scope] = await Promise.all([
        host.collaborationGroupMembers({ operation: 'status', ...coordinate }),
        host.collaborationWorkspace({ ...coordinate, operation: { kind: 'get' } }),
      ])
      if (snapshot.state !== 'snapshot' || snapshot.group_id !== prepared.group_id ||
        !scope.ok || !Array.isArray(scope.value?.selected_project_ids)) throw Error('Group unavailable')
      const [page, projectPage] = await Promise.all([
        host.collaborationWorkspace({ ...coordinate,
          operation: { kind: 'agents', query: { limit: 20 } } }),
        host.collaborationWorkspace({ ...coordinate,
          operation: { kind: 'projects', query: { limit: 20 } } }),
      ])
      if (!page.ok || page.value?.scope_version !== scope.value.version ||
        !projectPage.ok || !Array.isArray(projectPage.value?.items) ||
        !Array.isArray(page.value.items)) throw Error('Agent catalog unavailable')
      if (!alive.current || hostNow() !== host) return
      const selected = new Set(scope.value.selected_project_ids)
      setGroup(prepared)
      setMembers(snapshot.members.filter(member => member.actor_kind === 'slark_agent'))
      setScope(scope.value)
      setProjects(projectPage.value.items.filter(project => !selected.has(project.project_id)))
      setChoices(page.value.items.filter(agent => selected.has(agent.project_id) &&
        agent.available === true && agent.reason_code === 'ready'))
    } catch (error) { if (alive.current) setProblem(String(error?.message ?? error)) }
    finally { if (alive.current) setBusy(false) }
  }

  const enableProject = async project => {
    const host = hostNow()
    if (!readyHost(host) || !group || !scope || busy) return
    setBusy(true); setProblem('')
    try {
      const result = await host.collaborationWorkspace({ workspace_id: group.workspace_id,
        session_id: group.session_id, operation: { kind: 'apply', expected_version: scope.version,
          selected_project_ids: [...scope.selected_project_ids, project.project_id] } })
      if (!result.ok || !Array.isArray(result.value?.selected_project_ids) ||
        !result.value.selected_project_ids.includes(project.project_id))
        throw Error('Project scope needs refresh')
      if (alive.current && hostNow() === host) {
        setScope(result.value)
        setProjects(previous => previous.filter(item => item.project_id !== project.project_id))
        setProblem(t('Project enabled. Refresh Agents to choose one.'))
      }
    } catch (error) { if (alive.current) setProblem(String(error?.message ?? error)) }
    finally { if (alive.current) setBusy(false) }
  }

  const join = async agent => {
    const host = hostNow()
    if (!readyHost(host) || !group || busy) return
    setBusy(true); setProblem('')
    try {
      const coordinate = { workspace_id: group.workspace_id, session_id: group.session_id }
      const snapshot = await host.collaborationGroupMembers({ operation: 'status', ...coordinate })
      if (snapshot.state !== 'snapshot' || snapshot.group_id !== group.group_id)
        throw Error('Group unavailable')
      if (snapshot.members.some(member => member.actor_kind === 'slark_agent' &&
        member.agent?.project_id === agent.project_id && member.agent?.agent_id === agent.agent_id)) {
        setMembers(snapshot.members.filter(member => member.actor_kind === 'slark_agent'))
        return
      }
      const key = `join:${group.group_id}:${agent.project_id}:${agent.agent_id}`
      const requestId = requestIdFor(room.id, key)
      const command = { operation: 'agent_join', ...coordinate,
        request_id: requestId,
        expected_membership_version: snapshot.membership_version,
        project_id: agent.project_id, agent_id: agent.agent_id }
      let result = await host.collaborationGroupMembers(command)
      if (result.state === 'retry_required') result = await host.collaborationGroupMembers({
        operation: 'receipt', ...coordinate, request_id: command.request_id })
      if (result.state !== 'recorded' || result.operation !== 'agent_join')
        throw Error('Join needs reconciliation')
      clearRequestId(room.id, key)
      const current = await host.collaborationGroupMembers({ operation: 'status', ...coordinate })
      if (current.state !== 'snapshot' || current.group_id !== group.group_id)
        throw Error('Joined; refresh membership')
      if (alive.current && hostNow() === host)
        setMembers(current.members.filter(member => member.actor_kind === 'slark_agent'))
    } catch (error) { if (alive.current) setProblem(String(error?.message ?? error)) }
    finally { if (alive.current) setBusy(false) }
  }

  return h(Card, { title: t('Slark Agents') },
    h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
      h('span', { className: 'bt-set-hint' }, group
        ? t('Agents join this group chat and see only messages sent after they joined.')
        : t('Connect this group chat to Slark to add an Agent.')),
      h('button', { type: 'button', className: 'bt-mini', disabled: busy,
        onClick: () => { void connect() } }, group ? t('Refresh Agents') : t('Connect Slark'))),
    ...members.map(member => h('div', { key: member.member_id,
      className: 'bt-set-row bt-bs-row' },
    h('span', { className: 'bt-bs-label' }, `${member.agent?.agent_id ?? 'Agent'} · ${member.agent?.project_id ?? ''}`))),
    ...choices.filter(agent => !members.some(member => member.agent?.project_id === agent.project_id &&
      member.agent?.agent_id === agent.agent_id)).map(agent => h('button', { key: `${agent.project_id}:${agent.agent_id}`,
      type: 'button', className: 'bt-set-row bt-bs-row bt-gs-pick', disabled: busy,
      onClick: () => { void join(agent) } },
    h('span', { className: 'bt-bs-label' }, `${agent.agent_name} · ${agent.project_name}`),
    h('span', { className: 'bt-set-hint' }, t('Add')))),
    ...projects.map(project => h('button', { key: project.project_id,
      type: 'button', className: 'bt-set-row bt-bs-row bt-gs-pick', disabled: busy,
      onClick: () => { void enableProject(project) } },
    h('span', { className: 'bt-bs-label' }, project.project_name),
    h('span', { className: 'bt-set-hint' }, t('Enable project')))),
    problem ? h('div', { role: 'status', className: 'bt-set-row bt-set-hint' }, problem) : null)
}
