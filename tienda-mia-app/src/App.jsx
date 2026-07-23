import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Products from './pages/Products'
import Purchases from './pages/Purchases'
import PurchaseList from './pages/PurchaseList'
import Inventory from './pages/Inventory'
import Sales from './pages/Sales'
import Kitchen from './pages/Kitchen'
import Adjustments from './pages/Adjustments'
import ReturnsWaste from './pages/ReturnsWaste'
import Reports from './pages/Reports'
import Analytics from './pages/Analytics'
import Settings from './pages/Settings'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="products" element={<Products />} />
        <Route path="purchases" element={<Purchases />} />
        <Route path="purchase-list" element={<PurchaseList />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="sales" element={<Sales />} />
        <Route path="kitchen" element={<Kitchen />} />
        <Route path="adjustments" element={<Adjustments />} />
        <Route path="returns-waste" element={<ReturnsWaste />} />
        <Route path="reports" element={<Reports />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
